<?php
declare(strict_types=1);

/*
 * Kantor 3D tim AI (visualisasi) — alat internal, BUKAN bagian produk yang dikembangkan. Read-only.
 *   /kerja                 halaman 3D
 *   /kerja/api/state       status real: transkrip agent + planning/ (atau papan cadangan)
 *   /kerja/api/doc?path=   isi markdown di bawah planning/
 *   /kerja/evidence/<rel>  screenshot bukti QA
 *   /kerja/assets/<file>   JS (three.js dkk.) — prefiks /kerja agar aman dipasang di domain yang sudah ada
 * Server Node yang setara: bin/serve-node.mjs (rute & JSON sama — bin/parity.mjs).
 */
// server bawaan PHP (php -S … public/index.php): biarkan file statis (assets) dilayani langsung
if (PHP_SAPI === 'cli-server' && is_file(__DIR__ . (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH))
    && str_starts_with((string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH), '/assets/')) {
    return false;
}
date_default_timezone_set('UTC');
require dirname(__DIR__) . '/src/State.php';

$kerja = dirname(__DIR__);
$project = dirname($kerja);
$config = KerjaConfig::load($kerja . '/config.json', $project);
$path = rtrim((string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH), '/');
header('X-Robots-Tag: noindex, nofollow');
header('Referrer-Policy: no-referrer');
header('X-Content-Type-Options: nosniff');

if ($path === '' || $path === '/index.php') {
    header('Location: /kerja', true, 302);
    exit;
}
if ($path === '/kerja') {
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-cache');
    $page = (string) file_get_contents($kerja . '/views/page.html');
    $json = json_encode(KerjaState::pageConfig($config, KerjaState::discover($project, $kerja, $config)),
        JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_INVALID_UTF8_SUBSTITUTE);
    echo strtr($page, [
        '{{PROJECT}}' => htmlspecialchars($config['project'], ENT_QUOTES),
        '{{CONFIG_SCRIPT}}' => '<script>window.KERJA_CONFIG = ' . $json . ';</script>',
    ]);
    exit;
}
if ($path === '/kerja/api/state') {
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode(KerjaState::build($project, $kerja, $config), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}
if ($path === '/kerja/api/doc') {
    $md = (new Planning($project . '/planning'))->doc(is_string($_GET['path'] ?? null) ? $_GET['path'] : '');
    if ($md === null) {
        http_response_code(404);
        exit;
    }
    header('Content-Type: text/markdown; charset=utf-8');
    header('Cache-Control: no-store');
    echo $md;
    exit;
}
// aset di bawah /kerja/ agar tidak bentrok dengan /assets situs lain saat dipasang di domain yang sudah ada (Nginx)
if (str_starts_with($path, '/kerja/assets/')) {
    $base = realpath(__DIR__ . '/assets');
    $f = realpath(__DIR__ . '/assets/' . rawurldecode(substr($path, strlen('/kerja/assets/'))));
    if ($base === false || $f === false || !str_starts_with($f, $base . DIRECTORY_SEPARATOR) || !is_file($f)
        || strtolower(pathinfo($f, PATHINFO_EXTENSION)) !== 'js') {
        http_response_code(404);
        exit;
    }
    $etag = '"' . dechex((int) filemtime($f)) . '-' . dechex((int) filesize($f)) . '"';
    header('Content-Type: text/javascript; charset=utf-8');
    header('Cache-Control: public, max-age=3600');
    header('ETag: ' . $etag);
    if (($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) {
        http_response_code(304);
        exit;
    }
    header('Content-Length: ' . (int) filesize($f));
    readfile($f);
    exit;
}
if (str_starts_with($path, '/kerja/evidence/')) {
    $f = (new Planning($project . '/planning'))->evidencePath(rawurldecode(substr($path, strlen('/kerja/evidence/'))));
    if ($f === null) {
        http_response_code(404);
        exit;
    }
    $ext = strtolower(pathinfo($f, PATHINFO_EXTENSION));
    header('Content-Type: ' . (['png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'webp' => 'image/webp'][$ext] ?? 'application/octet-stream'));
    header('Cache-Control: max-age=60');
    header('Content-Length: ' . (int) filesize($f));
    readfile($f);
    exit;
}
http_response_code(404);
header('Content-Type: text/plain; charset=utf-8');
echo 'Tidak ditemukan';
