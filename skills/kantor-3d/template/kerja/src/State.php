<?php
declare(strict_types=1);

require_once __DIR__ . '/Config.php';
require_once __DIR__ . '/Transcripts.php';
require_once __DIR__ . '/Planning.php';
require_once __DIR__ . '/Discovery.php';
require_once __DIR__ . '/Fallback.php';

/**
 * Menyusun JSON /kerja/api/state dan konfigurasi halaman.
 * Port Node: node/state.mjs (harus identik — dicek bin/parity.mjs).
 */
final class KerjaState
{
    /** @return array<string,mixed> */
    public static function rules(string $kerjaDir): array
    {
        $r = json_decode((string) file_get_contents($kerjaDir . '/src/rules.json'), true);
        if (!is_array($r)) {
            throw new RuntimeException('src/rules.json tidak valid');
        }
        return $r;
    }

    /**
     * Temukan peran & ringkas transkrip.
     * @param array<string,mixed> $config
     * @return array{roles:list<array<string,mixed>>,overflow:list<array<string,mixed>>,runs:list<array<string,mixed>>,mains:list<array<string,mixed>>,team:?array<string,string>}
     */
    public static function discover(string $project, string $kerjaDir, array $config): array
    {
        $rules = self::rules($kerjaDir);
        $disc = new Discovery($project, $config, $rules);
        $scan = (new Transcripts($project, $kerjaDir, [$disc, 'resolve'], (int) $rules['window_days']))->scan();
        $team = Discovery::team($project);
        $sel = $disc->select($scan['runs'], $team);
        return ['roles' => $sel['roles'], 'overflow' => $sel['overflow'], 'runs' => $scan['runs'], 'mains' => $scan['mains'], 'team' => $team];
    }

    /** Konfigurasi untuk halaman (window.KERJA_CONFIG). @param array<string,mixed> $config @param array<string,mixed> $d hasil discover() */
    public static function pageConfig(array $config, array $d): array
    {
        return [
            'project' => $config['project'],
            'roles' => array_map([self::class, 'publicRole'], $d['roles']),
            'orchestrator' => $config['orchestrator'],
            'team' => $d['team'],
            'layout' => self::layout($d['roles']),
        ];
    }

    /** @param array<string,mixed> $r @return array<string,mixed> */
    private static function publicRole(array $r): array
    {
        return ['key' => $r['key'], 'name' => $r['name'], 'role' => $r['role'], 'color' => $r['color'], 'look' => $r['look'],
            'screen' => $r['screen'], 'asks' => $r['asks'], 'source' => $r['source']];
    }

    /** tanda susunan meja — berubah → halaman memuat ulang (peran baru mendapat meja) @param list<array<string,mixed>> $roles */
    private static function layout(array $roles): string
    {
        return implode(',', array_map(static fn($r) => $r['key'] . ':' . $r['name'] . ':' . $r['color'], $roles));
    }

    /** @param array<string,mixed> $config @return array<string,mixed> */
    public static function build(string $project, string $kerjaDir, array $config): array
    {
        $d = self::discover($project, $kerjaDir, $config);
        $runs = $d['runs'];
        $roleKeys = array_column($d['roles'], 'key');
        $asker = (string) (array_values(array_filter($d['roles'], static fn($r) => $r['asks']))[0]['key'] ?? '');
        $planning = new Planning($project . '/planning');
        $mode = $planning->exists() ? 'planning' : 'auto';
        $plan = $planning->snapshot();

        $agents = [];
        foreach ([...$roleKeys, 'orkestrator'] as $role) {
            $mine = array_values(array_filter($runs, static fn($r) => $r['role'] === $role));
            $agents[$role] = self::agent($mine);
        }
        $busy = array_filter($roleKeys, static fn($r) => $agents[$r]['state'] === 'bekerja');
        $pendingQ = array_values(array_filter($plan['roadmap']['questions'] ?? [], static fn($q) => $q['tag'] === 'BLOKIR' && !$q['answered']));
        if (!$busy && $pendingQ && isset($agents[$asker])) {
            $agents[$asker]['state'] = 'menunggu';
        }

        $overflow = [];
        foreach ($d['overflow'] as $o) {
            $mine = array_values(array_filter($runs, static fn($r) => $r['role'] === $o['key']));
            $a = self::agent($mine);
            $overflow[] = ['key' => $o['key'], 'name' => $o['name'], 'role' => $o['role'], 'color' => $o['color'],
                'state' => $a['state'], 'task' => $a['task'], 'updated' => $a['updated'], 'runs' => $a['runs']];
        }

        $feed = [];
        foreach ($runs as $r) {
            foreach ($r['events'] as $e) {
                if ($r['role'] === 'orkestrator' && !in_array($e['tool'], ['Agent', 'Task', 'SendMessage', 'AskUserQuestion', 'Skill', 'TaskStop'], true) && $e['kind'] !== 'user') {
                    continue;
                }
                $feed[] = $e + ['role' => $r['role'], 'run' => $r['id']];
            }
        }
        usort($feed, static fn($a, $b) => strcmp($b['t'], $a['t']));

        $tunnel = @file_get_contents($kerjaDir . '/storage/tunnel-url.txt');
        $tunnel = is_string($tunnel) ? trim($tunnel) : '';
        $sub = array_values(array_filter($runs, static fn($r) => $r['role'] !== 'orkestrator'));
        return [
            'now' => gmdate('c'),
            'mode' => $mode,
            'layout' => self::layout($d['roles']),
            'roles' => array_map([self::class, 'publicRole'], $d['roles']),
            'overflow' => $overflow,
            'team' => $d['team'],
            'agents' => $agents,
            'runs' => array_map(static fn($r) => [
                'id' => $r['id'], 'role' => $r['role'], 'description' => $r['description'], 'status' => $r['status'],
                'started' => $r['started'], 'updated' => $r['updated'], 'tools' => $r['tools'],
                'tokens' => $r['tokens']['in'] + $r['tokens']['out'] + $r['tokens']['cache'],
            ], array_slice($sub, 0, 30)),
            'feed' => array_slice($feed, 0, 120),
            'pending_questions' => $pendingQ,
            'totals' => [
                'runs' => count($sub),
                'tools' => array_sum(array_column($runs, 'tools')),
                'tokens' => array_sum(array_map(static fn($r) => $r['tokens']['in'] + $r['tokens']['out'] + $r['tokens']['cache'], $runs)),
            ],
            'fallback' => $mode === 'auto' ? Fallback::build($project, $runs, $d['mains']) : null,
            'public_url' => $tunnel !== '' ? $tunnel : $config['public_url'],
        ] + $plan;
    }

    /** @param list<array<string,mixed>> $mine run milik satu peran (terbaru dulu) @return array<string,mixed> */
    private static function agent(array $mine): array
    {
        $latest = $mine[0] ?? null;
        $active = array_values(array_filter($mine, static fn($r) => $r['status'] === 'bekerja'));
        $cur = $active[0] ?? $latest;
        return [
            'state' => $cur['status'] ?? 'siaga',
            'parallel' => count($active),
            'task' => $cur['description'] ?? null,
            'since' => $cur['started'] ?? null,
            'updated' => $cur['updated'] ?? null,
            'last' => $cur ? array_slice(array_reverse($cur['events']), 0, 8) : [],
            'final' => ($cur['status'] ?? '') === 'selesai' ? ($cur['final'] ?? null) : null,
            'limit' => $cur['limit'] ?? null,
            'files' => $cur ? array_map(static fn($f) => $f[0], array_slice($cur['files'], -8)) : [],
            'runs' => count($mine),
            'tools' => array_sum(array_column($mine, 'tools')),
            'tokens_out' => array_sum(array_map(static fn($r) => $r['tokens']['out'], $mine)),
            'tokens_all' => array_sum(array_map(static fn($r) => $r['tokens']['in'] + $r['tokens']['out'] + $r['tokens']['cache'], $mine)),
        ];
    }
}
