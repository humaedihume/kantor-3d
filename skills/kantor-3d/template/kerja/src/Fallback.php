<?php
declare(strict_types=1);

/**
 * Papan cadangan untuk project TANPA planning/ (format ROADMAP/BACKLOG/plans):
 *   - daftar tugas terbaru para agent (TodoWrite / TaskCreate / TaskUpdate di transkrip)
 *   - commit git terbaru (git log, tanpa shell, dengan batas waktu; turun dengan anggun bila git/exec tidak ada)
 *   - file yang paling sering diubah (event Write/Edit di transkrip)
 * Setiap papan diberi label sumbernya. Tidak ada data karangan.
 * Port Node: node/fallback.mjs (harus identik — dicek bin/parity.mjs).
 */
final class Fallback
{
    private const LISTS_KEEP = 8;
    private const COMMITS_KEEP = 12;
    private const HOT_KEEP = 12;
    private const GIT_TIMEOUT = 3.0;

    /**
     * @param list<array<string,mixed>> $runs  run subagent ber-peran (dari Transcripts::scan)
     * @param list<array<string,mixed>> $mains beberapa sesi utama terbaru
     * @return array<string,mixed>
     */
    public static function build(string $projectDir, array $runs, array $mains): array
    {
        $sources = array_merge(array_values(array_filter($runs, static fn($r) => $r['role'] !== 'orkestrator')), $mains);
        return [
            'todos' => self::todos($sources),
            'commits' => self::commits($projectDir),
            'hot_files' => self::hotFiles($sources),
        ];
    }

    /** @param list<array<string,mixed>> $sources @return list<array<string,mixed>> */
    private static function todos(array $sources): array
    {
        $lists = [];
        foreach ($sources as $r) {
            if (!is_array($r['todos'] ?? null) || !$r['todos']) {
                continue;
            }
            $lists[] = ['role' => $r['role'], 'run' => $r['id'], 't' => (string) $r['todosAt'], 'source' => (string) $r['todoSource'], 'items' => $r['todos']];
        }
        usort($lists, static fn($a, $b) => strcmp($b['t'], $a['t']));
        return array_slice($lists, 0, self::LISTS_KEEP);
    }

    /** @param list<array<string,mixed>> $sources @return list<array<string,mixed>> */
    private static function hotFiles(array $sources): array
    {
        $agg = [];
        foreach ($sources as $r) {
            foreach ((array) ($r['fileCounts'] ?? []) as $k => $v) {
                $path = substr((string) $k, 2);
                $a = $agg[$k] ?? ['path' => $path, 'count' => 0, 'last' => '', 'roles' => []];
                $a['count'] += (int) $v[0];
                if (strcmp((string) $v[1], $a['last']) > 0) {
                    $a['last'] = (string) $v[1];
                }
                if (!in_array($r['role'], $a['roles'], true)) {
                    $a['roles'][] = $r['role'];
                }
                $agg[$k] = $a;
            }
        }
        $list = array_values($agg);
        usort($list, static fn($a, $b) => ($b['count'] <=> $a['count']) ?: strcmp($b['last'], $a['last']) ?: strcmp($a['path'], $b['path']));
        return array_slice($list, 0, self::HOT_KEEP);
    }

    /**
     * git log tanpa shell (proc_open dengan array argumen), batas waktu, env aman.
     * @return array{available:bool,reason:?string,items:list<array{hash:string,t:string,subject:string}>}
     */
    public static function commits(string $projectDir): array
    {
        $none = static fn(string $why): array => ['available' => false, 'reason' => $why, 'items' => []];
        if (!is_dir($projectDir . '/.git') && !is_file($projectDir . '/.git')) {
            return $none('bukan repo git');
        }
        if (!function_exists('proc_open') || in_array('proc_open', array_map('trim', explode(',', (string) ini_get('disable_functions'))), true)) {
            return $none('exec dinonaktifkan di PHP');
        }
        $cmd = ['git', '-C', $projectDir, '--no-pager', 'log', '-n', (string) self::COMMITS_KEEP, '--no-color', '--pretty=format:%h%x1f%cI%x1f%s'];
        $env = ['PATH' => (string) (getenv('PATH') ?: '/usr/local/bin:/usr/bin:/bin'), 'HOME' => (string) getenv('HOME'),
            'GIT_TERMINAL_PROMPT' => '0', 'GIT_OPTIONAL_LOCKS' => '0', 'LC_ALL' => 'C'];
        $p = @proc_open($cmd, [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, $projectDir, $env);
        if (!is_resource($p)) {
            return $none('git tidak tersedia');
        }
        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);
        $out = '';
        $deadline = microtime(true) + self::GIT_TIMEOUT;
        $timedOut = false;
        while (true) {
            $out .= (string) stream_get_contents($pipes[1]);
            stream_get_contents($pipes[2]);
            $st = proc_get_status($p);
            if (!$st['running']) {
                $out .= (string) stream_get_contents($pipes[1]);
                $code = $st['exitcode'];
                break;
            }
            if (microtime(true) > $deadline) {
                $timedOut = true;
                proc_terminate($p, 9);
                $code = -1;
                break;
            }
            usleep(20000);
        }
        fclose($pipes[1]);
        fclose($pipes[2]);
        proc_close($p);
        if ($timedOut) {
            return $none('git terlalu lama (batas waktu)');
        }
        if ($code === 127) {
            return $none('git tidak tersedia');
        }
        if ($code !== 0) {
            return $none('git log gagal (repo kosong atau tidak bisa dibaca)');
        }
        $items = [];
        foreach (explode("\n", $out) as $line) {
            $c = explode("\x1f", $line);
            if (count($c) < 3 || $c[0] === '') {
                continue;
            }
            $ts = strtotime($c[1]);
            $items[] = [
                'hash' => $c[0],
                't' => $ts === false ? '' : gmdate('c', $ts),
                'subject' => Transcripts::clip(Transcripts::redact(trim($c[2])), 140),
            ];
        }
        return ['available' => true, 'reason' => null, 'items' => $items];
    }
}
