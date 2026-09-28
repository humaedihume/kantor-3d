<?php
declare(strict_types=1);

/**
 * Membaca transkrip Claude Code (JSONL) proyek ini secara inkremental dan meringkasnya per agent:
 * peran, status (bekerja/selesai/terhenti/limit), token, jumlah tool, event terakhir, daftar tugas (TodoWrite /
 * TaskCreate / TaskUpdate) dan file yang diubah. Hanya ringkasan tool_use + potongan teks assistant yang keluar —
 * isi tool_result (mis. isi .env) tidak pernah dibaca.
 * Port Node: node/transcripts.mjs (harus identik — dicek bin/parity.mjs).
 */
final class Transcripts
{
    private const EVENTS_KEEP = 80;
    private const RUNNING_WINDOW = 900; // detik tanpa aktivitas sebelum run dianggap terhenti
    private const CACHE_V = 5;
    private const FILES_KEEP = 40;
    private const FILE_COUNTS_KEEP = 300;
    private const TODOS_KEEP = 40;
    private const MAINS_KEEP = 5;

    /** @var callable(string,string):array{0:?string,1:string} */
    private $resolver;

    /** @param callable(string,string):array{0:?string,1:string} $resolver agentType + deskripsi → [key peran | null, deskripsi] */
    public function __construct(private string $projectDir, private string $kerjaDir, callable $resolver, private int $windowDays = 7)
    {
        $this->resolver = $resolver;
    }

    /** Folder transkrip project: $CLAUDE_CONFIG_DIR/projects/<slug> atau $HOME/.claude/projects/<slug>. */
    public static function transcriptRoot(string $projectDir): string
    {
        $base = (string) getenv('CLAUDE_CONFIG_DIR');
        if ($base === '') {
            $home = (string) getenv('HOME');
            if ($home === '' && function_exists('posix_getpwuid')) {
                $home = (string) (posix_getpwuid(posix_geteuid())['dir'] ?? '');
            }
            $base = rtrim($home, '/') . '/.claude';
        }
        return rtrim($base, '/') . '/projects/' . preg_replace('/[^a-zA-Z0-9]/', '-', $projectDir);
    }

    /**
     * Semua run (subagent ber-peran + orkestrator sesi terbaru), terbaru dulu, plus ringkasan beberapa sesi utama
     * terbaru (untuk papan cadangan: daftar tugas & file yang sering diubah).
     * @return array{runs:list<array<string,mixed>>,mains:list<array<string,mixed>>}
     */
    public function scan(): array
    {
        $root = self::transcriptRoot($this->projectDir);
        if (!is_dir($root)) {
            return ['runs' => [], 'mains' => []];
        }
        $runs = [];
        $cutoff = time() - $this->windowDays * 86400;
        $mainFiles = [];
        foreach (glob($root . '/*.jsonl') ?: [] as $main) {
            $mainFiles[] = [$main, (int) filemtime($main)];
        }
        // terbaru dulu; mtime sama → urutan nama (glob sudah urut)
        usort($mainFiles, static fn($a, $b) => $b[1] <=> $a[1]);
        foreach (glob($root . '/*/subagents/*.meta.json') ?: [] as $metaFile) {
            $jsonl = substr($metaFile, 0, -strlen('.meta.json')) . '.jsonl';
            if (!is_file($jsonl) || filemtime($jsonl) < $cutoff) {
                continue;
            }
            $meta = json_decode((string) file_get_contents($metaFile), true);
            $meta = is_array($meta) ? $meta : [];
            [$role, $desc] = ($this->resolver)(is_string($meta['agentType'] ?? null) ? $meta['agentType'] : '', is_string($meta['description'] ?? null) ? $meta['description'] : '');
            if ($role === null) {
                continue;
            }
            $sum = $this->summarize($jsonl);
            $sum['role'] = $role;
            $sum['description'] = $desc;
            $sum['id'] = substr(basename($jsonl, '.jsonl'), 6, 8);
            $runs[] = $sum;
        }
        $mains = [];
        foreach (array_slice($mainFiles, 0, self::MAINS_KEEP) as $i => [$file, $mt]) {
            if ($i > 0 && $mt < $cutoff) {
                break;
            }
            $sum = $this->summarize($file);
            $sum['role'] = 'orkestrator';
            $sum['description'] = 'Sesi utama — mengatur alur tim';
            $sum['id'] = $i === 0 ? 'main' : 'main-' . substr(basename($file, '.jsonl'), 0, 8);
            $mains[] = $sum;
        }
        if ($mains) {
            $runs[] = $mains[0];
        }
        // agent yang dihentikan orkestrator (TaskStop) tidak menulis akhir transkrip — dicatat di storage/stopped.txt
        $stopped = [];
        $sf = $this->kerjaDir . '/storage/stopped.txt';
        if (is_file($sf)) {
            foreach (preg_split('/\R/u', (string) file_get_contents($sf)) ?: [] as $line) {
                if (preg_match('/^\s*(a[0-9a-f]{7,})/', $line, $m)) {
                    $stopped[substr($m[1], 0, 8)] = true;
                }
            }
        }
        foreach ($runs as &$r) {
            $r['status'] = self::statusOf($r);
            if ($r['status'] === 'bekerja' && isset($stopped[$r['id']])) {
                $r['status'] = 'terhenti';
            }
        }
        unset($r);
        usort($runs, static fn($a, $b) => strcmp((string) $b['updated'], (string) $a['updated']));
        return ['runs' => $runs, 'mains' => $mains];
    }

    /** @param array<string,mixed> $r */
    private static function statusOf(array $r): string
    {
        if (!empty($r['limit'])) {
            return 'limit';
        }
        if ($r['role'] === 'orkestrator') {
            return time() - (int) $r['mtime'] < 90 ? 'bekerja' : 'siaga';
        }
        if (in_array($r['lastKind'] ?? '', ['final', 'handback'], true)) {
            return 'selesai';
        }
        return time() - (int) $r['mtime'] <= self::RUNNING_WINDOW ? 'bekerja' : 'terhenti';
    }

    /** @return array<string,mixed> */
    private function summarize(string $file): array
    {
        $size = (int) filesize($file);
        $mtime = (int) filemtime($file);
        $cacheFile = $this->kerjaDir . '/storage/cache/t-' . md5($file) . '.json';
        $s = is_file($cacheFile) ? json_decode((string) file_get_contents($cacheFile), true) : null;
        if (!is_array($s) || ($s['v'] ?? 0) !== self::CACHE_V || (int) ($s['offset'] ?? -1) > $size || (int) ($s['offset'] ?? -1) < 0) {
            $s = ['v' => self::CACHE_V, 'offset' => 0, 'started' => null, 'updated' => null, 'tools' => 0,
                  'tokens' => ['in' => 0, 'out' => 0, 'cache' => 0], 'lastMsgId' => null, 'events' => [],
                  'lastKind' => null, 'final' => null, 'prompt' => null, 'limit' => null, 'files' => [], 'fileCounts' => [],
                  'todos' => null, 'todosAt' => null, 'todoSource' => null, 'tasks' => [], 'taskSeq' => 0];
        }
        if ((int) $s['offset'] < $size) {
            $fh = fopen($file, 'rb');
            if ($fh !== false) {
                fseek($fh, (int) $s['offset']);
                $pos = (int) $s['offset'];
                while (($line = fgets($fh)) !== false) {
                    if (!str_ends_with($line, "\n")) {
                        break; // baris belum lengkap ditulis — baca lagi nanti
                    }
                    $pos += strlen($line);
                    $row = json_decode($line, true);
                    if (is_array($row) && !array_is_list($row)) {
                        $this->consume($s, $row);
                    }
                }
                fclose($fh);
                $s['offset'] = $pos;
            }
            if (is_dir(dirname($cacheFile)) || @mkdir(dirname($cacheFile), 0775, true)) {
                @file_put_contents($cacheFile, json_encode($s, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE), LOCK_EX);
            }
        }
        $s['mtime'] = $mtime;
        unset($s['lastMsgId'], $s['offset'], $s['v'], $s['tasks'], $s['taskSeq']);
        return $s;
    }

    /** @param array<string,mixed> $s @param array<string,mixed> $row */
    private function consume(array &$s, array $row): void
    {
        $type = $row['type'] ?? '';
        $t = is_string($row['timestamp'] ?? null) ? $row['timestamp'] : '';
        if ($t !== '') {
            $s['started'] ??= $t;
            $s['updated'] = $t;
        }
        $msg = $row['message'] ?? null;
        if (!is_array($msg)) {
            return;
        }
        if ($type === 'user') {
            $content = $msg['content'] ?? '';
            if (is_string($content)) {
                if ($s['prompt'] === null && !str_starts_with(ltrim($content), '<')) {
                    $s['prompt'] = self::clip(self::redact($content), 400);
                }
                if (empty($row['isMeta']) && !str_starts_with(ltrim($content), '<') && $s['prompt'] !== null && ($row['isSidechain'] ?? false) === false) {
                    $this->push($s, $t, 'user', 'Instruksi dari user', null);
                }
                $s['lastKind'] = 'user';
            } elseif (is_array($content) && $s['lastKind'] !== 'handback') {
                $s['lastKind'] = 'result';
            }
            return;
        }
        if ($type !== 'assistant') {
            return;
        }
        $id = is_string($msg['id'] ?? null) ? $msg['id'] : '';
        if ($id !== '' && $id !== $s['lastMsgId'] && is_array($msg['usage'] ?? null)) {
            $u = $msg['usage'];
            $s['tokens']['in'] += self::int($u['input_tokens'] ?? 0);
            $s['tokens']['out'] += self::int($u['output_tokens'] ?? 0);
            $s['tokens']['cache'] += self::int($u['cache_read_input_tokens'] ?? 0) + self::int($u['cache_creation_input_tokens'] ?? 0);
            $s['lastMsgId'] = $id;
        }
        $hasTool = false;
        $hasText = false;
        $handback = false;
        foreach (is_array($msg['content'] ?? null) ? $msg['content'] : [] as $b) {
            if (!is_array($b)) {
                continue;
            }
            $bt = $b['type'] ?? '';
            if ($bt === 'tool_use') {
                $hasTool = true;
                $name = is_string($b['name'] ?? null) ? $b['name'] : '?';
                $in = is_array($b['input'] ?? null) ? $b['input'] : [];
                $s['tools']++;
                [$text, $path] = $this->describeTool($name, $in);
                if ($path !== null && in_array($name, ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'], true)) {
                    // daftar [path, waktu] (bukan map: kunci numerik PHP bisa berubah jadi int)
                    $s['files'] = array_values(array_filter($s['files'], static fn($f) => $f[0] !== $path));
                    $s['files'][] = [$path, $t];
                    if (count($s['files']) > self::FILES_KEEP) {
                        array_shift($s['files']);
                    }
                    $fk = 'p:' . $path;
                    if (isset($s['fileCounts'][$fk]) || count($s['fileCounts']) < self::FILE_COUNTS_KEEP) {
                        $s['fileCounts'][$fk] = [(int) ($s['fileCounts'][$fk][0] ?? 0) + 1, $t];
                    }
                }
                $this->todo($s, $name, $in, $t);
                if ($name === 'SubagentHandback') {
                    $handback = true;
                    if (is_string($in['message'] ?? null) && trim($in['message']) !== '') {
                        $s['final'] = self::clip(self::redact(trim($in['message'])), 1200);
                    }
                }
                $this->push($s, $t, 'tool', $text, $name);
            } elseif ($bt === 'text') {
                $txt = is_string($b['text'] ?? null) ? trim($b['text']) : '';
                if ($txt === '') {
                    continue;
                }
                $hasText = true;
                if (preg_match('/(usage limit|rate limit|limit reached|resets? (at|in))/i', $txt) && mb_strlen($txt) < 400) {
                    $s['limit'] = self::clip($txt, 200);
                }
                $s['final'] = self::clip(self::redact($txt), 1200);
                $this->push($s, $t, 'text', self::clip(self::redact(self::firstLine(self::redact($txt))), 180), null);
            }
        }
        $stop = is_string($msg['stop_reason'] ?? null) ? $msg['stop_reason'] : '';
        if ($handback) {
            $s['lastKind'] = 'handback';
        } elseif ($hasTool) {
            $s['lastKind'] = 'tool';
        } elseif ($hasText) {
            $s['lastKind'] = $stop === 'end_turn' ? 'final' : 'text';
        } else {
            $s['lastKind'] ??= 'thinking'; // blok thinking saja tidak mengubah status
        }
        if ($hasTool) {
            $s['limit'] = null;
        }
    }

    /**
     * Daftar tugas agent: TodoWrite (daftar lengkap menggantikan yang lama) atau TaskCreate/TaskUpdate
     * (id diperkirakan dari urutan TaskCreate di transkrip ini, karena id asli hanya ada di tool_result).
     * @param array<string,mixed> $s @param array<string,mixed> $in
     */
    private function todo(array &$s, string $name, array $in, string $t): void
    {
        if ($name === 'TodoWrite' && is_array($in['todos'] ?? null)) {
            $items = [];
            foreach ($in['todos'] as $td) {
                if (!is_array($td)) {
                    continue;
                }
                $text = is_string($td['content'] ?? null) ? $td['content'] : (is_string($td['subject'] ?? null) ? $td['subject'] : '');
                if (trim($text) === '') {
                    continue;
                }
                $items[] = ['text' => self::clip(self::redact(self::firstLine(self::redact($text))), 120), 'status' => self::todoStatus($td['status'] ?? null)];
                if (count($items) >= self::TODOS_KEEP) {
                    break;
                }
            }
            $s['todos'] = $items;
            $s['todosAt'] = $t;
            $s['todoSource'] = 'TodoWrite';
            return;
        }
        if ($name === 'TaskCreate') {
            $subject = is_string($in['subject'] ?? null) ? $in['subject'] : (is_string($in['description'] ?? null) ? $in['description'] : '');
            $s['taskSeq']++;
            if (trim($subject) === '') {
                return;
            }
            $s['tasks']['#' . $s['taskSeq']] = ['text' => self::clip(self::redact(self::firstLine(self::redact($subject))), 120), 'status' => 'pending'];
            if (count($s['tasks']) > self::TODOS_KEEP) {
                array_shift($s['tasks']);
            }
        } elseif ($name === 'TaskUpdate') {
            $tid = $in['taskId'] ?? $in['id'] ?? null;
            $tid = is_string($tid) || is_int($tid) ? '#' . $tid : '';
            if (!isset($s['tasks'][$tid])) {
                return;
            }
            if (($in['status'] ?? null) === 'deleted') {
                unset($s['tasks'][$tid]);
            } else {
                if (is_string($in['status'] ?? null)) {
                    $s['tasks'][$tid]['status'] = self::todoStatus($in['status']);
                }
                if (is_string($in['subject'] ?? null) && trim($in['subject']) !== '') {
                    $s['tasks'][$tid]['text'] = self::clip(self::redact(self::firstLine(self::redact($in['subject']))), 120);
                }
            }
        } else {
            return;
        }
        $s['todos'] = array_values($s['tasks']);
        $s['todosAt'] = $t;
        $s['todoSource'] = 'Task';
    }

    private static function todoStatus(mixed $v): string
    {
        return in_array($v, ['pending', 'in_progress', 'completed'], true) ? $v : 'pending';
    }

    private static function int(mixed $v): int
    {
        return is_int($v) ? $v : (is_float($v) ? (int) $v : 0);
    }

    /** @param array<string,mixed> $s */
    private function push(array &$s, string $t, string $kind, string $text, ?string $tool): void
    {
        $s['events'][] = ['t' => $t, 'kind' => $kind, 'text' => $text, 'tool' => $tool];
        if (count($s['events']) > self::EVENTS_KEEP) {
            array_splice($s['events'], 0, count($s['events']) - self::EVENTS_KEEP);
        }
    }

    /** @param array<string,mixed> $in @return array{0:string,1:?string} */
    private function describeTool(string $name, array $in): array
    {
        $str = static fn($v): string => is_string($v) ? $v : (is_int($v) || is_float($v) ? (string) $v : '');
        $path = null;
        if (is_string($in['file_path'] ?? null) && $in['file_path'] !== '') {
            $p = $in['file_path'];
            $path = str_starts_with($p, $this->projectDir . '/') ? substr($p, strlen($this->projectDir) + 1) : basename($p);
        } elseif (is_string($in['notebook_path'] ?? null) && $in['notebook_path'] !== '') {
            $p = $in['notebook_path'];
            $path = str_starts_with($p, $this->projectDir . '/') ? substr($p, strlen($this->projectDir) + 1) : basename($p);
        }
        $text = match ($name) {
            'Read' => 'Membaca ' . $path,
            'Write' => 'Menulis ' . $path,
            'Edit', 'MultiEdit', 'NotebookEdit' => 'Mengubah ' . $path,
            'Bash' => 'Menjalankan: ' . ($str($in['description'] ?? null) !== '' ? $str($in['description']) : self::firstToken($str($in['command'] ?? null)) . ' …'),
            'Grep' => "Mencari '" . self::clip($str($in['pattern'] ?? null), 50) . "'",
            'Glob' => 'Mencari file ' . self::clip($str($in['pattern'] ?? null), 60),
            'Agent', 'Task' => 'Mendelegasikan: ' . ($str($in['description'] ?? null) !== '' ? $str($in['description']) : 'subagent'),
            'SendMessage' => 'Mengirim pesan ke agent',
            'AskUserQuestion' => 'Bertanya ke user',
            'WebFetch', 'WebSearch' => 'Riset web',
            'Skill' => 'Memuat skill ' . $str($in['skill'] ?? null),
            'TodoWrite' => 'Memperbarui daftar tugas',
            'TaskCreate' => 'Membuat tugas: ' . $str($in['subject'] ?? null),
            'TaskUpdate' => 'Memperbarui tugas' . ($str($in['status'] ?? null) !== '' ? ' → ' . $str($in['status']) : ''),
            'TaskStop' => 'Menghentikan agent',
            'SubagentHandback' => 'Menyerahkan laporan ke pemanggil',
            default => $name,
        };
        return [self::clip(self::redact($text), 160), $path];
    }

    /** kata pertama perintah (tanpa argumen — argumen bisa berisi rahasia) */
    private static function firstToken(string $cmd): string
    {
        foreach (preg_split('/[ \n]+/', $cmd) ?: [] as $tok) {
            if ($tok !== '') {
                return $tok;
            }
        }
        return '';
    }

    public static function firstLine(string $s): string
    {
        foreach (preg_split('/\R/u', $s) ?: [] as $l) {
            $l = trim((string) preg_replace('/[#*`>|_]+/', ' ', $l));
            if ($l !== '') {
                return (string) preg_replace('/[ \t\n\x0B\f\r]+/', ' ', $l);
            }
        }
        return '';
    }

    public static function redact(string $s): string
    {
        $s = (string) preg_replace('/(pass(word)?|sandi|secret|token|api[_-]?key)(["\'\s]*[:=]\s*)(\S+)/i', '$1$3•••', $s);
        $s = (string) preg_replace("/--login=['\"]?[^'\"\s]+/", '--login=•••', $s);
        $s = (string) preg_replace('/\bsk-[A-Za-z0-9_\-]{8,}/', 'sk-•••', $s);
        $s = (string) preg_replace('/\b(gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/', '•••', $s);
        return (string) preg_replace('/\b[a-f0-9]{40,}\b/i', '•••', $s);
    }

    public static function clip(string $s, int $n): string
    {
        return mb_strlen($s) > $n ? mb_substr($s, 0, $n - 1) . '…' : $s;
    }
}
