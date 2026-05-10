<?php
// 调试期开错误显示（上线后可以注释这两行）
error_reporting(E_ALL);
ini_set('display_errors', '1');

use Firebase\JWT\JWT;
/**
 * Discuz → Doudizhu 跨域 SSO 桥接
 *
 * 使用：
 *   把 fight-the-landlord 部署到独立子域（如 ddz.yutianfu.me），
 *   访问 https://zwwx.club/discuz-sso/bridge.php?redirect=https://ddz.yutianfu.me/
 *
 * 行为：
 *   - 已在 Discuz 登录 → 生成 JWT，302 到 redirect 地址，并把 token 放到 URL hash：
 *       https://ddz.yutianfu.me/#token=<JWT>
 *   - 未登录       → 302 到 Discuz 登录页，并通过 referer 让登录后跳回本桥接，
 *                    然后再次走「已登录」分支。
 *
 * 安全：
 *   - 仅允许跳转到白名单域名（见 $ALLOW_HOSTS），避免被作开放跳转。
 *   - JWT 的 secret 与 Node 端共用 JWT_SECRET。
 *
 * 部署：
 *   - 放到 /www/wwwroot/zwwx_club/discuz-sso/bridge.php
 *   - 必须先安装 firebase/php-jwt：composer require firebase/php-jwt
 */

// ====== 配置 ======
$ALLOW_HOSTS = [
    'ddz.yutianfu.me',
    // 如果还有其它前端域名，加进来
];
// JWT 有效期（秒）
$JWT_TTL = 86400;

// ====== 先取 redirect 并校验（必须在 Discuz init 之前，Discuz 会对 $_GET 做 addslashes） ======
$redirect = isset($_GET['redirect']) ? (string)$_GET['redirect'] : '';
$redirect = stripslashes($redirect); // 防 magic_quotes / Discuz 转义
if (!$redirect) {
    http_response_code(400);
    echo 'missing redirect';
    exit;
}
$parts = parse_url($redirect);
if (empty($parts['host']) || !in_array(strtolower($parts['host']), array_map('strtolower', $ALLOW_HOSTS), true)) {
    http_response_code(400);
    echo 'redirect host not allowed';
    exit;
}
if (!isset($parts['scheme']) || !in_array($parts['scheme'], ['http', 'https'], true)) {
    http_response_code(400);
    echo 'invalid scheme';
    exit;
}

// ====== 引导 Discuz ======
define('CURSCRIPT', 'index');
define('APPTYPEID', 0);
$discuz_root = dirname(__DIR__);
// 必须切到 Discuz 根目录，否则 class_core 用相对路径加载 config 会失败，cookie 也读不到
chdir($discuz_root);
require $discuz_root . '/source/class/class_core.php';
$discuz = C::app();
$discuz->init();

// ====== 载入 PHP-JWT ======
// \u4f18\u5148 composer autoload\uff1b\u5982\u679c\u62ff\u4e0d\u5230\u5219\u9000\u5316\u5230\u76f4\u63a5 require \u6e90\u6587\u4ef6\u3002
$autoloads = [
    $discuz_root . '/vendor/autoload.php',
    __DIR__ . '/vendor/autoload.php',
    __DIR__ . '/../vendor/autoload.php',
];
foreach ($autoloads as $f) { if (file_exists($f)) { require_once $f; break; } }
if (!class_exists('Firebase\\JWT\\JWT')) {
    $candidates = [
        $discuz_root . '/vendor/firebase/php-jwt/src/',
        __DIR__ . '/vendor/firebase/php-jwt/src/',
        __DIR__ . '/../vendor/firebase/php-jwt/src/',
    ];
    foreach ($candidates as $base) {
        if (file_exists($base . 'JWT.php')) {
            foreach (['JWT.php', 'Key.php', 'BeforeValidException.php',
                      'ExpiredException.php', 'SignatureInvalidException.php'] as $f) {
                if (file_exists($base . $f)) require_once $base . $f;
            }
            break;
        }
    }
}
if (!class_exists('Firebase\\JWT\\JWT')) {
    http_response_code(500);
    echo 'php-jwt not installed (composer require firebase/php-jwt)';
    echo "\nsearched:\n - " . $discuz_root . "/vendor/autoload.php\n - " . __DIR__ . "/vendor/autoload.php\n - " . $discuz_root . "/vendor/firebase/php-jwt/src/JWT.php\n";
    exit;
}

// ====== 取 secret ======
$SSO_SECRET = defined('DISCUZ_SSO_SECRET') ? DISCUZ_SSO_SECRET : (getenv('JWT_SECRET') ?: '');
if (!$SSO_SECRET) {
    http_response_code(500);
    echo 'DISCUZ_SSO_SECRET not set';
    exit;
}

// ====== 未登录则去 Discuz 登录页 ======
$uid = intval($_G['uid']);
if (!$uid) {
    $self = (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off' ? 'https' : 'http')
        . '://' . $_SERVER['HTTP_HOST'] . $_SERVER['REQUEST_URI'];
    // 用站点根的绝对路径，避免落到 /discuz-sso/member.php
    $loginUrl = '/member.php?mod=logging&action=login&referer=' . rawurlencode($self);
    header('Location: ' . $loginUrl);
    exit;
}

// ====== 已登录：签发 JWT 并跳回 ======
$now = time();
$payload = [
    'uid'      => $uid,
    'username' => strval($_G['member']['username']),
    'iat'      => $now,
    'exp'      => $now + intval($JWT_TTL),
];
$jwt = JWT::encode($payload, $SSO_SECRET, 'HS256');

// 把 token 放到 fragment，避免被中间日志记录到 query
$sep = (strpos($redirect, '#') === false) ? '#' : '&';
$target = $redirect . $sep . 'token=' . rawurlencode($jwt);
header('Location: ' . $target);
exit;
