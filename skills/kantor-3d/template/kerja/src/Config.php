<?php
declare(strict_types=1);

/**
 * kerja/config.json (OPSIONAL) → konfigurasi ternormalisasi. Tanpa file ini semuanya otomatis.
 * Format: {"project","host","public_url","auto","max_desks","hide":[…],
 *          "roles":[{"key","name","role","color","look","screen","asks_user","aliases","hide"}],"orchestrator":{"name","role"}}
 * Format lama ({"team":{"analyst":{…},"developer":{…},"qa":{…},"orkestrator":{…}}}) tetap didukung.
 * Peran di "roles" = penimpaan (nama, warna, gaya, urutan) untuk peran yang ditemukan otomatis dan selalu
 * diutamakan mendapat meja. "auto": false = hanya peran yang tertulis di "roles" (perilaku lama).
 * Port Node: node/config.mjs (harus identik — dicek bin/parity.mjs).
 */
final class KerjaConfig
{
    public const MAX_ROLES = 6;

    /** @return array<string,mixed> */
    public static function load(string $file, string $projectDir): array
    {
        $c = is_file($file) ? json_decode((string) file_get_contents($file), true) : null;
        $c = is_array($c) ? $c : [];
        $roles = [];
        if (!empty($c['roles']) && is_array($c['roles'])) {
            foreach ($c['roles'] as $r) {
                if (!is_array($r)) {
                    continue;
                }
                $key = self::slug(self::str($r['key'] ?? null) ?? self::str($r['role'] ?? null) ?? '');
                if ($key === '' || $key === 'orkestrator' || isset($roles[$key])) {
                    continue;
                }
                $aliases = [];
                foreach (is_array($r['aliases'] ?? null) ? $r['aliases'] : [] as $a) {
                    if (is_string($a) && ($s = self::slug($a)) !== '') {
                        $aliases[] = $s;
                    }
                }
                $roles[$key] = [
                    'key' => $key,
                    'name' => self::str($r['name'] ?? null),
                    'role' => self::str($r['role'] ?? null),
                    'color' => self::color($r['color'] ?? null),
                    'look' => is_array($r['look'] ?? null) && !array_is_list($r['look']) ? $r['look'] : null,
                    'screen' => in_array($r['screen'] ?? null, ['docs', 'files', 'evidence', 'commands'], true) ? $r['screen'] : null,
                    'asks' => !empty($r['asks_user']),
                    'hide' => !empty($r['hide']),
                    'aliases' => $aliases,
                ];
            }
        } elseif (is_array($c['team'] ?? null)) {
            $t = $c['team'];
            foreach (['analyst' => ['Pingot', 'Analyst'], 'developer' => ['Zaki', 'Developer'], 'qa' => ['Lulu', 'QA']] as $k => [$n, $ro]) {
                $roles[$k] = ['key' => $k, 'name' => self::str($t[$k]['name'] ?? null) ?? $n, 'role' => self::str($t[$k]['role'] ?? null) ?? $ro,
                    'color' => null, 'look' => null, 'screen' => null, 'asks' => false, 'hide' => false, 'aliases' => []];
            }
        }
        $hide = [];
        foreach (is_array($c['hide'] ?? null) ? $c['hide'] : [] as $h) {
            if (is_string($h) && ($s = self::slug($h)) !== '') {
                $hide[$s] = true;
            }
        }
        foreach ($roles as $k => $r) {
            if ($r['hide']) {
                $hide[$k] = true;
            }
        }
        $max = is_int($c['max_desks'] ?? null) ? max(1, min(self::MAX_ROLES, $c['max_desks'])) : self::MAX_ROLES;
        $o = is_array($c['orchestrator'] ?? null) ? $c['orchestrator'] : (is_array($c['team']['orkestrator'] ?? null) ? $c['team']['orkestrator'] : []);
        $url = self::str($c['public_url'] ?? null);
        return [
            'project' => self::str($c['project'] ?? null) ?? basename($projectDir),
            'host' => self::str($c['host'] ?? null) ?? '',
            // URL publik tetap (mis. domain Nginx di server); kosong = pakai URL tunnel bila ada
            'public_url' => $url !== null && preg_match('#^https?://[^\s"<>]+$#', $url) ? $url : null,
            'auto' => ($c['auto'] ?? true) !== false,
            'max_desks' => $max,
            'hide' => array_keys($hide),
            'roles' => array_values($roles),
            'orchestrator' => [
                'name' => self::str($o['name'] ?? null) ?? 'Orkestrator',
                'role' => self::str($o['role'] ?? null) ?? 'Sesi utama',
            ],
        ];
    }

    public static function slug(string $s): string
    {
        return trim((string) preg_replace('/[^a-z0-9]+/', '-', strtolower($s)), '-');
    }

    public static function color(mixed $v): ?string
    {
        return is_string($v) && preg_match('/^#[0-9a-fA-F]{6}$/', $v) ? strtolower($v) : null;
    }

    /** string tidak kosong (dipangkas) atau null */
    public static function str(mixed $v): ?string
    {
        if (!is_string($v)) {
            return null;
        }
        $v = trim($v);
        return $v === '' ? null : $v;
    }
}
