<?php
declare(strict_types=1);

/**
 * Membaca folder planning/: roadmap (modul, fase, pertanyaan), plan, laporan QA, bukti screenshot, dokumen.
 * Port Node: node/planning.mjs (harus identik — dicek bin/parity.mjs).
 */
final class Planning
{
    public function __construct(private string $dir)
    {
    }

    /** Format planning tim AI dipakai project ini (ROADMAP/BACKLOG/plans) → papan memakai planning; bila tidak → papan cadangan. */
    public function exists(): bool
    {
        return is_file($this->dir . '/ROADMAP.md') || is_file($this->dir . '/BACKLOG.md') || is_dir($this->dir . '/plans');
    }

    /** @return array<string,mixed> */
    public function snapshot(): array
    {
        $plans = $this->plans();
        $roadmap = $this->roadmap($plans);
        return [
            'roadmap' => $roadmap,
            'plans' => $plans,
            'qa' => $this->qaReports(),
            'evidence' => $this->evidence(),
            'docs' => $this->docs(),
            'deferred' => $this->deferred(),
        ];
    }

    /** @return list<array<string,mixed>> */
    private function plans(): array
    {
        $out = [];
        foreach (glob($this->dir . '/plans/*.md') ?: [] as $f) {
            $md = (string) file_get_contents($f);
            $fm = self::frontmatter($md);
            preg_match_all('/^\s*- \[( |x|X)\] /m', $md, $m);
            $done = count(array_filter($m[1], static fn($c) => strtolower($c) === 'x'));
            preg_match_all('/^\|\s*AC\d+\s*\|/m', $md, $ac);
            $id = (string) ($fm['id'] ?? substr(basename($f), 0, 3));
            $out[] = [
                'id' => trim($id, "\"' "),
                'title' => trim((string) ($fm['judul'] ?? self::h1($md) ?? basename($f, '.md')), "\"' "),
                'status' => (string) ($fm['status'] ?? 'draft'),
                'qa_round' => (int) ($fm['qa_ronde'] ?? 0),
                'tasks_done' => $done,
                'tasks_total' => count($m[1]),
                'ac_total' => count($ac[0]),
                'depends_on' => (string) ($fm['depends_on'] ?? ''),
                'path' => 'planning/plans/' . basename($f),
                'updated' => date('c', (int) filemtime($f)),
            ];
        }
        usort($out, static fn($a, $b) => strcmp($a['id'], $b['id']));
        return $out;
    }

    /** @param list<array<string,mixed>> $plans @return array<string,mixed> */
    private function roadmap(array $plans): array
    {
        $f = $this->dir . '/ROADMAP.md';
        if (!is_file($f)) {
            return ['exists' => false, 'modules' => [], 'phases' => [], 'questions' => []];
        }
        $md = (string) file_get_contents($f);
        $modules = [];
        foreach (preg_split('/\R/u', $md) ?: [] as $line) {
            if (!str_starts_with(ltrim($line), '|')) {
                continue;
            }
            $cells = array_map(static fn($c) => trim(str_replace(['**', '`'], '', $c)), explode('|', trim(trim($line), '|')));
            $idIdx = null;
            foreach ($cells as $i => $c) {
                if (preg_match('/^M(\d{2})$/', $c)) {
                    $idIdx = $i;
                    break;
                }
            }
            if ($idIdx === null) {
                continue;
            }
            $id = $cells[$idIdx];
            $mod = $modules[$id] ?? ['id' => $id, 'name' => '', 'status' => null, 'pct' => null, 'size' => null];
            if ($mod['name'] === '' && isset($cells[$idIdx + 1])) {
                $mod['name'] = self::shortName($cells[$idIdx + 1]);
            }
            foreach ($cells as $c) {
                if ($mod['pct'] === null && preg_match('/^~?\s*(\d{1,3})\s*%/', $c, $p)) {
                    $mod['pct'] = min(100, (int) $p[1]);
                }
                if ($mod['status'] === null && preg_match('/\b(SUDAH|SEBAGIAN|BELUM)\b/i', $c, $st)) {
                    $mod['status'] = strtoupper($st[1]);
                }
                if ($mod['size'] === null && preg_match('/^(S|M|L|XL)$/', $c)) {
                    $mod['size'] = $c;
                }
            }
            $modules[$id] = $mod;
        }
        // progres modul = persentase audit + porsi sisa yang sudah diselesaikan lewat plan modul itu
        foreach ($modules as $id => &$mod) {
            $num = substr($id, 1);
            $mine = array_values(array_filter($plans, static fn($p) => str_starts_with($p['id'], $num) && strlen($p['id']) === 3));
            $base = $mod['pct'] ?? ($mod['status'] === 'SUDAH' ? 100 : ($mod['status'] === 'SEBAGIAN' ? 50 : 0));
            $mod['audit_pct'] = $base;
            $mod['plans'] = array_map(static fn($p) => $p['id'], $mine);
            if ($mine) {
                $units = 0.0;
                foreach ($mine as $p) {
                    $units += $p['status'] === 'done' ? 1.0 : ($p['tasks_total'] > 0 ? 0.85 * $p['tasks_done'] / $p['tasks_total'] : 0.0);
                }
                $base = (int) round($base + (100 - $base) * $units / count($mine));
                $mod['plan_status'] = self::aggregateStatus($mine);
            } else {
                $mod['plan_status'] = null;
            }
            $mod['progress'] = $base;
        }
        unset($mod);

        $phases = [];
        // fase: baris tabel "| **0. Baseline** | M01 (010) | …" atau judul "Fase N …"
        if (preg_match_all('/^\|\s*\**\s*(\d{1,2})\.\s*([^|*]+?)\**\s*\|\s*([^|]*)\|/m', $md, $ph, PREG_SET_ORDER)) {
            foreach ($ph as $p) {
                $phases[] = ['n' => (int) $p[1], 'name' => trim($p[2]), 'modules' => trim(str_replace(['**', '`'], '', $p[3]))];
            }
        } elseif (preg_match_all('/^#{2,4}\s*Fase\s*(\d+)[\s.:—-]*(.*)$/mi', $md, $ph, PREG_SET_ORDER)) {
            foreach ($ph as $p) {
                $phases[] = ['n' => (int) $p[1], 'name' => trim(str_replace(['**', '`'], '', $p[2])), 'modules' => ''];
            }
        }
        return [
            'exists' => true,
            'updated' => date('c', (int) filemtime($f)),
            'modules' => array_values($modules),
            'phases' => $phases,
            'questions' => self::questions($md),
            'summary' => self::section($md, '/^#{2}\s*.*(ringkasan|kondisi)/i', 900),
        ];
    }

    /** @param list<array<string,mixed>> $plans */
    private static function aggregateStatus(array $plans): string
    {
        $st = array_column($plans, 'status');
        foreach (['in-progress', 'qa-failed', 'ready-for-qa', 'blocked', 'approved', 'draft'] as $s) {
            if (in_array($s, $st, true)) {
                return $s;
            }
        }
        return 'done';
    }

    /** @return list<array<string,mixed>> */
    private static function questions(string $md): array
    {
        $out = [];
        $lines = preg_split('/\R/u', $md) ?: [];
        $cur = null;
        $flush = static function () use (&$cur, &$out): void {
            if ($cur !== null) {
                $body = implode("\n", $cur['body']);
                $out[] = [
                    'id' => $cur['id'],
                    'title' => $cur['title'],
                    'tag' => preg_match('/\[BLOKIR\]/i', $cur['title'] . $body) ? 'BLOKIR' : (preg_match('/\[ASUMSI\]/i', $cur['title'] . $body) ? 'ASUMSI' : ''),
                    'answered' => (bool) preg_match('/(^|\n)\s*>?\s*(✅|\*\*Jawaban user)/u', $body),
                    'recommendation' => preg_match('/rekomendasi[^:]*:\s*(.+)/i', $body, $r) ? Transcripts::clip(trim(str_replace(['**', '`'], '', $r[1])), 220) : null,
                ];
            }
            $cur = null;
        };
        foreach ($lines as $l) {
            if (preg_match('/^(?:#{2,5}\s*|\s*[-*]\s*\*\*|\*\*)\s*Q(\d{1,2})\b[\s.:\)—\-]*\**\s*(.*)$/', $l, $m)) {
                $flush();
                $cur = ['id' => 'Q' . $m[1], 'title' => trim(str_replace(['**', '`'], '', $m[2])), 'body' => []];
                continue;
            }
            if ($cur !== null) {
                if (preg_match('/^#{1,3}\s/', $l) && !preg_match('/^#{1,3}\s*Q\d/', $l)) {
                    $flush();
                    continue;
                }
                $cur['body'][] = $l;
            }
        }
        $flush();
        $seen = [];
        return array_values(array_filter($out, static function ($q) use (&$seen) {
            if (isset($seen[$q['id']])) {
                return false;
            }
            return $seen[$q['id']] = true;
        }));
    }

    /** Baris tabel planning/DITUNDA.md (bagian yang dilewati karena bahan belum lengkap). @return list<array<string,mixed>> */
    private function deferred(): array
    {
        $f = $this->dir . '/DITUNDA.md';
        if (!is_file($f)) {
            return [];
        }
        $out = [];
        foreach (preg_split('/\R/u', (string) file_get_contents($f)) ?: [] as $l) {
            if (!preg_match('/^\|\s*\d{4}-\d{2}-\d{2}/', $l)) {
                continue;
            }
            $c = array_map('trim', explode('|', trim(trim($l), '|')));
            $done = str_contains($l, '~~');
            $clean = static fn($v) => trim(str_replace(['~~', '**', '`'], '', (string) $v));
            $out[] = ['date' => $clean($c[0] ?? ''), 'plan' => $clean($c[1] ?? ''), 'item' => $clean($c[2] ?? ''), 'reason' => $clean($c[3] ?? ''), 'need' => $clean($c[4] ?? ''), 'done' => $done];
        }
        return $out;
    }

    /** @return list<array<string,mixed>> */
    private function qaReports(): array
    {
        $out = [];
        foreach (glob($this->dir . '/qa/*.md') ?: [] as $f) {
            $md = (string) file_get_contents($f);
            $name = basename($f, '.md');
            preg_match('/^(\d{3})(?:-qa-r(\d+))?/', $name, $m);
            $verdict = preg_match('/Verdict:?\**\s*:?\s*\**\s*(PASS|FAIL)/i', $md, $v) ? strtoupper($v[1]) : null;
            preg_match_all('/^#{2,4}\s*B\d+\b/m', $md, $bugs);
            $out[] = [
                'file' => $name,
                'plan' => $m[1] ?? '',
                'round' => isset($m[2]) ? (int) $m[2] : 0,
                'verdict' => $verdict,
                'bugs' => count($bugs[0]),
                'title' => self::h1($md) ?? $name,
                'path' => 'planning/qa/' . basename($f),
                'updated' => date('c', (int) filemtime($f)),
            ];
        }
        usort($out, static fn($a, $b) => strcmp($b['updated'], $a['updated']));
        return $out;
    }

    /** @return list<array<string,mixed>> */
    private function evidence(): array
    {
        $files = [];
        $root = $this->dir . '/qa/evidence';
        if (!is_dir($root)) {
            return [];
        }
        $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS));
        foreach ($it as $f) {
            if ($f->isFile() && preg_match('/\.(png|jpe?g|webp)$/i', $f->getFilename())) {
                $rel = substr($f->getPathname(), strlen($root) + 1);
                $files[] = ['path' => $rel, 'plan' => explode('/', $rel)[0], 'name' => $f->getBasename('.' . $f->getExtension()), 't' => $f->getMTime()];
            }
        }
        usort($files, static fn($a, $b) => ($b['t'] <=> $a['t']) ?: strcmp($a['path'], $b['path']));
        return array_map(static fn($e) => $e + ['updated' => date('c', $e['t'])], array_slice($files, 0, 36));
    }

    /** @return list<array<string,mixed>> */
    private function docs(): array
    {
        $out = [];
        $add = function (string $f) use (&$out): void {
            $md = (string) file_get_contents($f);
            $out[] = ['path' => substr($f, strlen(dirname($this->dir)) + 1), 'title' => self::h1($md) ?? basename($f), 'updated' => date('c', (int) filemtime($f)), 'bytes' => strlen($md)];
        };
        foreach (array_merge(glob($this->dir . '/*.md') ?: [], glob($this->dir . '/plans/*.md') ?: [], glob($this->dir . '/qa/*.md') ?: []) as $f) {
            $add($f);
        }
        usort($out, static fn($a, $b) => strcmp($b['updated'], $a['updated']));
        return $out;
    }

    /** Isi markdown dokumen di bawah planning/ (untuk panel baca). */
    public function doc(string $rel): ?string
    {
        $rel = ltrim($rel, '/');
        if (!preg_match('#^planning/[A-Za-z0-9_\-/]+\.md$#', $rel) || str_contains($rel, '..')) {
            return null;
        }
        $f = dirname($this->dir) . '/' . $rel;
        return is_file($f) ? Transcripts::redact((string) file_get_contents($f)) : null;
    }

    public function evidencePath(string $rel): ?string
    {
        if (!preg_match('#^[A-Za-z0-9_\-/]+\.(png|jpe?g|webp)$#i', $rel) || str_contains($rel, '..')) {
            return null;
        }
        $f = $this->dir . '/qa/evidence/' . $rel;
        return is_file($f) ? $f : null;
    }

    /** @return array<string,string> */
    private static function frontmatter(string $md): array
    {
        if (!preg_match('/^---\R(.*?)\R---/s', $md, $m)) {
            return [];
        }
        $out = [];
        foreach (preg_split('/\R/u', $m[1]) ?: [] as $l) {
            if (preg_match('/^([a-z_]+):\s*(.*?)\s*(#.*)?$/i', $l, $kv)) {
                $out[$kv[1]] = $kv[2];
            }
        }
        return $out;
    }

    private static function h1(string $md): ?string
    {
        return preg_match('/^#\s+(.+)$/m', $md, $m) ? trim(str_replace(['**', '`'], '', $m[1])) : null;
    }

    private static function shortName(string $s): string
    {
        return Transcripts::clip(trim((string) preg_replace('/\s*\(.*?\)\s*/', ' ', $s)), 48);
    }

    private static function section(string $md, string $headRe, int $max): ?string
    {
        $lines = preg_split('/\R/u', $md) ?: [];
        $buf = null;
        foreach ($lines as $l) {
            if ($buf === null) {
                if (preg_match($headRe, $l)) {
                    $buf = [];
                }
                continue;
            }
            if (preg_match('/^#{1,2}\s/', $l)) {
                break;
            }
            $buf[] = $l;
        }
        return $buf === null ? null : Transcripts::clip(trim(implode("\n", $buf)), $max);
    }
}
