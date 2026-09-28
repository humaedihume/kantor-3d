<?php
declare(strict_types=1);

/**
 * Penemuan peran otomatis (tanpa config):
 *   1. kerja/config.json "roles" (penimpaan, opsional)
 *   2. agent project .claude/agents/*.md (frontmatter name, description, color)
 *   3. setiap agentType di .meta.json transkrip (termasuk bawaan: general-purpose, Explore, Plan, claude, …)
 *   4. awalan deskripsi "Peran: …" untuk agent umum (general-purpose dkk.) yang cocok dengan peran di atas
 *      atau kosakata peran tim (rules.json "vocabulary").
 * Maks. max_desks meja: peran yang paling baru aktif; sisanya dilaporkan sebagai "overflow" (tidak disembunyikan).
 * Port Node: node/discovery.mjs (harus identik — dicek bin/parity.mjs).
 */
final class Discovery
{
    private const TIER = ['config' => 0, 'agent-file' => 1, 'builtin' => 2, 'transcript' => 2, 'prefix' => 2];

    /** @var array<string,array<string,mixed>> key → kandidat */
    private array $cand = [];
    /** @var array<string,string> alias (slug) → key */
    private array $alias = [];
    /** @var array<string,bool> */
    private array $hidden = [];
    private int $seq = 0;

    /** @param array<string,mixed> $config dari KerjaConfig::load @param array<string,mixed> $rules src/rules.json */
    public function __construct(private string $projectDir, private array $config, private array $rules)
    {
        foreach ($config['hide'] as $h) {
            $this->hidden[$h] = true;
        }
        foreach ($config['roles'] as $i => $r) {
            if (isset($this->hidden[$r['key']])) {
                continue;
            }
            $this->add($r['key'], 'config', ['cfg' => $r, 'idx' => $i]);
        }
        if ($config['auto']) {
            foreach (self::agentFiles($projectDir) as $a) {
                if (isset($this->hidden[$a['key']])) {
                    continue;
                }
                if (isset($this->cand[$a['key']])) {
                    $this->cand[$a['key']]['fileColor'] = $a['color'];
                    $this->cand[$a['key']]['hasFile'] = true;
                } else {
                    $this->add($a['key'], 'agent-file', ['fileColor' => $a['color'], 'hasFile' => true]);
                }
            }
        }
        $this->rebuildAliases();
    }

    private function ensure(string $t): void
    {
        if (!isset($this->cand[$t]) && !isset($this->hidden[$t])) {
            $this->add($t, in_array($t, $this->rules['builtin_types'], true) ? 'builtin' : 'transcript');
            $this->rebuildAliases();
        }
    }

    /** @param array<string,mixed> $extra */
    private function add(string $key, string $source, array $extra = []): void
    {
        $this->cand[$key] = array_merge([
            'key' => $key, 'source' => $source, 'tier' => self::TIER[$source], 'idx' => 0, 'seq' => $this->seq++,
            'cfg' => null, 'fileColor' => null, 'hasFile' => false,
        ], $extra);
    }

    private function rebuildAliases(): void
    {
        $this->alias = [];
        $put = function (string $a, string $key): void {
            $a = KerjaConfig::slug($a);
            if ($a !== '' && !isset($this->alias[$a])) {
                $this->alias[$a] = $key;
            }
        };
        foreach ($this->cand as $key => $c) {
            $put($key, $key);
        }
        foreach ($this->cand as $key => $c) {
            if ($c['cfg'] !== null) {
                $put((string) ($c['cfg']['name'] ?? ''), $key);
                $put((string) ($c['cfg']['role'] ?? ''), $key);
                foreach ($c['cfg']['aliases'] as $a) {
                    $put($a, $key);
                }
            }
        }
        foreach ($this->rules['aliases'] as $a => $target) {
            if (isset($this->cand[$target])) {
                $put((string) $a, $target);
            }
        }
    }

    /**
     * Peran untuk satu run subagent.
     * @return array{0:?string,1:string} [key | null (disembunyikan / auto mati), deskripsi tanpa awalan peran]
     */
    public function resolve(string $agentType, string $desc): array
    {
        $t = KerjaConfig::slug($agentType);
        if ($t === '') {
            $t = 'general-purpose';
        }
        $generic = in_array($t, $this->rules['generic_types'], true);
        $role = null;
        $out = trim($desc);
        $pre = preg_match('/^\s*([\p{L}\p{N} _.\-]{1,40}?)\s*[:—]\s*(.*)$/su', $desc, $m) ? [KerjaConfig::slug($m[1]), trim($m[2])] : null;
        if (!$generic && isset($this->alias[$t])) {
            $role = $this->alias[$t];
        } elseif (!$generic && $this->config['auto']) {
            // agent kustom/plugin/bawaan non-umum: agentType itu sendiri = peran
            $role = $t;
            $this->ensure($t);
        }
        if ($role !== null) {
            // "Analyst: revisi …" untuk agent analyst → tugas tanpa awalan
            if ($pre !== null && ($this->alias[$pre[0]] ?? null) === $role) {
                $out = $pre[1];
            }
        } else {
            if ($pre !== null) {
                if (isset($this->alias[$pre[0]])) {
                    $role = $this->alias[$pre[0]];
                } elseif ($this->config['auto']) {
                    $canon = $this->rules['aliases'][$pre[0]] ?? $pre[0];
                    if (in_array($canon, $this->rules['vocabulary'], true) && !isset($this->hidden[$canon])) {
                        $this->add($canon, 'prefix');
                        $this->rebuildAliases();
                        $role = $canon;
                    }
                }
                if ($role !== null) {
                    $out = $pre[1];
                }
            }
            if ($role === null && $this->config['auto']) {
                $role = $t;
                $this->ensure($t);
            }
        }
        if ($role === null || isset($this->hidden[$role])) {
            return [null, $out];
        }
        return [$role, $out];
    }

    /**
     * Pilih peran bermeja (paling baru aktif, maks max_desks), urutkan stabil, beri nama/warna.
     * @param list<array<string,mixed>> $runs @param ?array<string,mixed> $team .claude/tim-ai.json
     * @return array{roles:list<array<string,mixed>>,overflow:list<array<string,mixed>>}
     */
    public function select(array $runs, ?array $team): array
    {
        $last = [];
        $count = [];
        foreach ($runs as $r) {
            $k = (string) $r['role'];
            if ($k === 'orkestrator' || !isset($this->cand[$k])) {
                continue;
            }
            $count[$k] = ($count[$k] ?? 0) + 1;
            $u = (string) ($r['updated'] ?? '');
            if ($u !== '' && strcmp($u, (string) ($last[$k] ?? '')) > 0) {
                $last[$k] = $u;
            }
        }
        $all = array_values($this->cand);
        // peran di config.json dipin (selalu dapat meja, urut config); sisanya: yang paling baru aktif dulu,
        // belum pernah aktif → agent project dulu
        $byRecent = $all;
        usort($byRecent, static function ($a, $b) use ($last) {
            $pa = $a['tier'] === 0 ? 0 : 1;
            $pb = $b['tier'] === 0 ? 0 : 1;
            if ($pa !== $pb || $pa === 0) {
                return ($pa <=> $pb) ?: ($a['idx'] <=> $b['idx']);
            }
            $la = (string) ($last[$a['key']] ?? '');
            $lb = (string) ($last[$b['key']] ?? '');
            return strcmp($lb, $la) ?: ($a['tier'] <=> $b['tier']) ?: ($a['seq'] <=> $b['seq']);
        });
        $max = (int) $this->config['max_desks'];
        $chosen = array_slice($byRecent, 0, $max);
        $rest = array_slice($byRecent, $max);
        $order = array_flip($this->rules['order']);
        $stable = function (array $list) use ($order): array {
            usort($list, static function ($a, $b) use ($order) {
                if ($a['tier'] !== $b['tier']) {
                    return $a['tier'] <=> $b['tier'];
                }
                if ($a['tier'] === 0) {
                    return $a['idx'] <=> $b['idx'];
                }
                return (($order[$a['key']] ?? 100) <=> ($order[$b['key']] ?? 100)) ?: strcmp($a['key'], $b['key']);
            });
            return $list;
        };
        $chosen = $stable($chosen);
        $rest = $stable($rest);

        $used = [];
        $info = function (array $c) use (&$used, $last, $count): array {
            $cfg = $c['cfg'] ?? [];
            $color = $cfg['color'] ?? null;
            if ($color === null && $c['fileColor'] !== null) {
                $color = $this->rules['color_names'][$c['fileColor']] ?? KerjaConfig::color($c['fileColor']);
            }
            $color ??= $this->rules['preset_colors'][$c['key']] ?? null;
            if ($color === null) {
                $pal = $this->rules['palette'];
                $start = self::hash($c['key']) % count($pal);
                $color = $pal[$start];
                for ($i = 0; $i < count($pal); $i++) {
                    $cand = $pal[($start + $i) % count($pal)];
                    if (!isset($used[$cand])) {
                        $color = $cand;
                        break;
                    }
                }
            }
            $used[$color] = true;
            $source = $c['source'] === 'config' ? ($c['hasFile'] ? 'agent-file' : 'config') : $c['source'];
            return [
                'key' => $c['key'],
                'name' => $cfg['name'] ?? $this->rules['names'][$c['key']] ?? $this->humanize($c['key']),
                // nama karakter dari config → label peran = nama peran; tanpa itu → asal peran (Agent project/bawaan)
                'role' => $cfg['role'] ?? (($cfg['name'] ?? null) !== null ? ($this->rules['names'][$c['key']] ?? $this->humanize($c['key'])) : $this->rules['source_labels'][$source]),
                'color' => $color,
                'look' => $cfg['look'] ?? null,
                'screen' => $cfg['screen'] ?? null,
                'asks' => (bool) ($cfg['asks'] ?? false),
                'source' => $source,
                'last_active' => $last[$c['key']] ?? null,
                'runs' => $count[$c['key']] ?? 0,
            ];
        };
        $roles = array_map($info, $chosen);
        $overflow = array_map($info, $rest);
        if ($roles && !array_filter($roles, static fn($r) => $r['asks'])) {
            $keys = array_column($roles, 'key');
            $plan = is_string($team['plan'] ?? null) ? $team['plan'] : null;
            $pick = $plan !== null && in_array($plan, $keys, true) ? $plan : (in_array('analyst', $keys, true) ? 'analyst' : $keys[0]);
            foreach ($roles as &$r) {
                $r['asks'] = $r['key'] === $pick;
            }
            unset($r);
        }
        usort($overflow, static fn($a, $b) => strcmp((string) $b['last_active'], (string) $a['last_active']));
        return ['roles' => $roles, 'overflow' => $overflow];
    }

    public function humanize(string $key): string
    {
        $words = [];
        foreach (explode('-', $key) as $w) {
            if ($w === '') {
                continue;
            }
            $words[] = in_array($w, $this->rules['acronyms'], true) ? strtoupper($w) : ucfirst($w);
        }
        return $words ? implode(' ', $words) : $key;
    }

    /** hash deterministik yang sama dengan node/discovery.mjs (dan kantor.js) */
    public static function hash(string $s): int
    {
        $h = 7;
        $n = strlen($s);
        for ($i = 0; $i < $n; $i++) {
            $h = ($h * 31 + ord($s[$i])) & 0xFFFFFFFF;
        }
        return $h;
    }

    /** @return list<array{key:string,color:?string}> agent project dari .claude/agents/*.md */
    public static function agentFiles(string $projectDir): array
    {
        $out = [];
        foreach (glob($projectDir . '/.claude/agents/*.md') ?: [] as $f) {
            if (!is_file($f)) {
                continue;
            }
            $head = (string) file_get_contents($f, false, null, 0, 8192);
            $fm = [];
            if (preg_match('/^---\r?\n(.*?)\r?\n---/s', $head, $m)) {
                foreach (preg_split('/\r?\n/', $m[1]) ?: [] as $l) {
                    if (preg_match('/^([A-Za-z_-]+):[ \t]*(.*?)[ \t]*$/', $l, $kv)) {
                        $fm[strtolower($kv[1])] = trim($kv[2], "\"' ");
                    }
                }
            }
            $key = KerjaConfig::slug(($fm['name'] ?? '') !== '' ? $fm['name'] : basename($f, '.md'));
            if ($key === '' || $key === 'orkestrator') {
                continue;
            }
            $out[] = ['key' => $key, 'color' => ($fm['color'] ?? '') !== '' ? strtolower($fm['color']) : null];
        }
        return $out;
    }

    /** @return ?array<string,string> .claude/tim-ai.json (dari skill tim-ai): peran plan/execute/review */
    public static function team(string $projectDir): ?array
    {
        $f = $projectDir . '/.claude/tim-ai.json';
        if (!is_file($f)) {
            return null;
        }
        $j = json_decode((string) file_get_contents($f), true);
        if (!is_array($j)) {
            return null;
        }
        $out = [];
        foreach (['preset', 'plan', 'execute', 'review'] as $k) {
            $v = $j[$k] ?? null;
            if (is_array($v) && array_is_list($v)) {
                $v = $v[0] ?? null;
            }
            if (is_string($v) && ($s = KerjaConfig::slug($v)) !== '') {
                $out[$k] = $s;
            }
        }
        return $out ?: null;
    }
}
