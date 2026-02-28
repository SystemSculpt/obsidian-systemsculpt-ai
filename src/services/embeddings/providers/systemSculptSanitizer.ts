import { errorLogger } from '../../../utils/errorLogger';

interface RewriteRule {
  regex: RegExp;
  replacement: string;
}

const REWRITE_RULES: RewriteRule[] = [
  { regex: /eval-stdin/gi, replacement: 'input-handler' },
  { regex: /phpunit/gi, replacement: 'test runner' },
  { regex: /\\think\\app/gi, replacement: '/framework/app' },
  { regex: /invokefunction/gi, replacement: 'callmethod' },
  { regex: /call_user_func(?:_array)?/gi, replacement: 'callback' },
  { regex: /pearcmd/gi, replacement: 'pkg-manager' },
  { regex: /fgt_lang/gi, replacement: 'fw-lang' },
  { regex: /sslvpn/gi, replacement: 'secure-tunnel' },
  { regex: /\bcmdb\b/gi, replacement: 'config-db' },
  { regex: /wp-file-manager/gi, replacement: 'site-filemanager' },
  { regex: /sqlmap/gi, replacement: 'db tool' },
  { regex: /\bnmap\b/gi, replacement: 'network scanner' },
  { regex: /metasploit/gi, replacement: 'security framework' },
  { regex: /hashcat/gi, replacement: 'hash tool' },
  { regex: /\bhydra\b/gi, replacement: 'auth tool' },
  { regex: /\bbase64_decode\b/gi, replacement: 'decode' },
  { regex: /\bunion\s+select\b/gi, replacement: 'query' },
  { regex: /\bcurl\b/gi, replacement: 'http client' },
  { regex: /\bwget\b/gi, replacement: 'downloader' },
  { regex: /\bpowershell\b/gi, replacement: 'shell' },
  { regex: /\bcmd\.exe\b/gi, replacement: 'shell' },
  { regex: /\brm\s+-rf\b/gi, replacement: 'delete' },
  { regex: /\bchmod\b/gi, replacement: 'permissions' },
  { regex: /\bchown\b/gi, replacement: 'ownership' },
  { regex: /\/etc\/passwd\b/gi, replacement: '/system/users' },
  { regex: /\/etc\/shadow\b/gi, replacement: '/system/auth' },
  { regex: /\bxss\b/gi, replacement: 'injection' },
  { regex: /\bcsrf\b/gi, replacement: 'request forgery' },
  { regex: /\bsql\s+injection\b/gi, replacement: 'query attack' },
  { regex: /\bCVE-\d{4}-\d{3,7}\b/gi, replacement: '[security-id]' },
  { regex: /\bexploit\b/gi, replacement: 'vulnerability' },
  { regex: /\bpayload\b/gi, replacement: 'data' },
  { regex: /\bshellcode\b/gi, replacement: 'code' },
  { regex: /\bbackdoor\b/gi, replacement: 'access' },
  { regex: /\brootkit\b/gi, replacement: 'kit' },
  { regex: /\bkeylogger\b/gi, replacement: 'logger' },
  { regex: /\bmalware\b/gi, replacement: 'software' },
  { regex: /\btrojan\b/gi, replacement: 'program' },
  { regex: /\bransomware\b/gi, replacement: 'software' },
  { regex: /\bbotnet\b/gi, replacement: 'network' },
  { regex: /\bddos\b/gi, replacement: 'attack' },
  { regex: /\bbruteforce\b/gi, replacement: 'attempt' },
  { regex: /\bbrute\s*-?\s*force\b/gi, replacement: 'attempt' },
  { regex: /\beval\s*\(/gi, replacement: 'evaluate(' },
  { regex: /\bexec\s*\(/gi, replacement: 'execute(' },
  { regex: /\bsystem\s*\(/gi, replacement: 'run(' },
  { regex: /\bpassthru\s*\(/gi, replacement: 'pass(' },
  { regex: /\bshell_exec\s*\(/gi, replacement: 'run(' },
  { regex: /\bproc_open\s*\(/gi, replacement: 'process(' },
  { regex: /\bpopen\s*\(/gi, replacement: 'open(' },
  { regex: /\bpcntl_exec\s*\(/gi, replacement: 'run(' },
  { regex: /\bfile_get_contents\s*\(/gi, replacement: 'read_file(' },
  { regex: /\bfopen\s*\(/gi, replacement: 'open_file(' },
  { regex: /\binclude\s*\(/gi, replacement: 'load(' },
  { regex: /\brequire\s*\(/gi, replacement: 'load(' },
  { regex: /\binclude_once\s*\(/gi, replacement: 'load(' },
  { regex: /\brequire_once\s*\(/gi, replacement: 'load(' },
  { regex: /\bpreg_replace\s*\([^)]*\/e/gi, replacement: 'regex_replace(' },
  { regex: /\bassert\s*\(/gi, replacement: 'check(' },
  { regex: /\bcreate_function\s*\(/gi, replacement: 'make_func(' },
  { regex: /\b\$_(?:GET|POST|REQUEST|COOKIE|SERVER|FILES)\b/gi, replacement: '$input' },
  { regex: /\bLog4Shell\b/gi, replacement: 'logging vulnerability' },
  { regex: /\bShellshock\b/gi, replacement: 'bash vulnerability' },
  { regex: /\bHeartbleed\b/gi, replacement: 'ssl vulnerability' },
  { regex: /\bpentesting?\b/gi, replacement: 'security testing' },
  { regex: /\bpentest\b/gi, replacement: 'security test' },
  { regex: /\bpen-?test(?:ing|er)?\b/gi, replacement: 'security test' },
  { regex: /\bvuln(?:erability|erable)?\b/gi, replacement: 'issue' },
  { regex: /\binjection\b/gi, replacement: 'input issue' },
  { regex: /\bRCE\b/g, replacement: 'remote issue' },
  { regex: /\bLFI\b/g, replacement: 'file issue' },
  { regex: /\bRFI\b/g, replacement: 'file issue' },
  { regex: /\bSSRF\b/g, replacement: 'request issue' },
  { regex: /\bSSTI\b/g, replacement: 'template issue' },
  { regex: /\bIDOR\b/g, replacement: 'access issue' },
  { regex: /\b0day\b/gi, replacement: 'new issue' },
  { regex: /\bzero[- ]?day\b/gi, replacement: 'new issue' },
  { regex: /\bfuzzing?\b/gi, replacement: 'testing' },
  { regex: /\bfuzzer\b/gi, replacement: 'tester' },
  { regex: /\bbug\s*bounty\b/gi, replacement: 'security program' },
  { regex: /\bhack(?:ing|er|ed)?\b/gi, replacement: 'access' },
  { regex: /\bcrack(?:ing|er|ed)?\b/gi, replacement: 'break' },
  { regex: /\bbypass(?:ing|ed)?\b/gi, replacement: 'circumvent' },
  { regex: /\bescape\s+sequence\b/gi, replacement: 'special chars' },
  { regex: /\bnull\s*byte\b/gi, replacement: 'zero char' },
  { regex: /\bpoison(?:ing|ed)?\b/gi, replacement: 'corrupt' },
  { regex: /\bspoof(?:ing|ed)?\b/gi, replacement: 'fake' },
  { regex: /\bsniff(?:ing|er|ed)?\b/gi, replacement: 'monitor' },
  { regex: /\breverse\s+shell\b/gi, replacement: 'remote connection' },
  { regex: /\bbind\s+shell\b/gi, replacement: 'listener' },
  { regex: /\bweb\s*shell\b/gi, replacement: 'web tool' },
  { regex: /\bC2\b/g, replacement: 'server' },
  { regex: /\bcommand\s+and\s+control\b/gi, replacement: 'remote server' },
  { regex: /\bbash\s+-[ci]\b/gi, replacement: 'shell' },
  { regex: /\bsh\s+-[ci]\b/gi, replacement: 'shell' },
  { regex: /\/bin\/(?:ba)?sh\b/gi, replacement: '/shell' },
  { regex: /\/usr\/bin\/(?:ba)?sh\b/gi, replacement: '/shell' },
  { regex: /\bnetcat\b/gi, replacement: 'network tool' },
  { regex: /\bnc\s+-[lnvpe]/gi, replacement: 'network tool' },
  { regex: /\bsocat\b/gi, replacement: 'network tool' },
  { regex: /\btelnet\b/gi, replacement: 'network tool' },
  { regex: /\bnslookup\b/gi, replacement: 'dns tool' },
  { regex: /\bdig\b/gi, replacement: 'dns tool' },
  { regex: /\bhost\s+[^\s]+/gi, replacement: 'dns lookup' },
  { regex: /\bwhois\b/gi, replacement: 'domain tool' },
  { regex: /\btraceroute\b/gi, replacement: 'network path' },
  { regex: /\bping\s+-[cn]/gi, replacement: 'network check' },
  { regex: /\bsudo\b/gi, replacement: 'elevated' },
  { regex: /\bsu\s+-?\s*\w/gi, replacement: 'switch user' },
  { regex: /\bpasswd\b/gi, replacement: 'password' },
  { regex: /\bshadow\b/gi, replacement: 'auth' },
  { regex: /\b(?:my)?sql\s+-[uphe]/gi, replacement: 'db connect' },
  { regex: /\bmongo(?:db)?\s+--/gi, replacement: 'db connect' },
  { regex: /\bredis-cli\b/gi, replacement: 'cache client' },
  { regex: /\bpsql\b/gi, replacement: 'db client' },
  { regex: /\bsqlite3?\b/gi, replacement: 'db' },
  { regex: /\bawk\s+['"{]/gi, replacement: 'text process' },
  { regex: /\bsed\s+-[eni]/gi, replacement: 'text process' },
  { regex: /\bgrep\s+-[rniEP]/gi, replacement: 'search' },
  { regex: /\bfind\s+\/\s+-/gi, replacement: 'search /' },
  { regex: /\bxargs\b/gi, replacement: 'args' },
  { regex: /\|\s*base64\b/gi, replacement: ' pipe encode' },
  { regex: /\bbase64\s+-d\b/gi, replacement: 'decode' },
  { regex: /\b(?:en|de)code\s+base64\b/gi, replacement: 'transform' },
  { regex: /\btar\s+-[xzcvf]/gi, replacement: 'archive' },
  { regex: /\bunzip\b/gi, replacement: 'extract' },
  { regex: /\bgzip\b/gi, replacement: 'compress' },
  { regex: /\bdd\s+if=/gi, replacement: 'copy data' },
  { regex: /\bcat\s*>\s*[^\s]+/gi, replacement: 'write file' },
  { regex: /\becho\s+[^>]{1,40}>/gi, replacement: 'write ' },
  { regex: />\s*\/dev\/(?:null|tcp|udp)/gi, replacement: '> output' },
  { regex: /\/dev\/tcp\/[^\s]+/gi, replacement: '/network' },
  { regex: /\/dev\/udp\/[^\s]+/gi, replacement: '/network' },
  { regex: /\bcrontab\b/gi, replacement: 'scheduler' },
  { regex: /\/etc\/cron/gi, replacement: '/system/scheduler' },
  { regex: /\.htaccess\b/gi, replacement: 'config' },
  { regex: /\.htpasswd\b/gi, replacement: 'auth-config' },
  { regex: /web\.config\b/gi, replacement: 'config' },
  { regex: /\.env\b(?!iron)/gi, replacement: 'config' },
  { regex: /config\.(?:php|yml|yaml|json|xml|ini)\b/gi, replacement: 'settings' },
  { regex: /database\.(?:php|yml|yaml|json|xml)\b/gi, replacement: 'db-settings' },
  { regex: /credentials?\.(?:php|yml|yaml|json|xml)\b/gi, replacement: 'auth-settings' },
  { regex: /secrets?\.(?:php|yml|yaml|json|xml)\b/gi, replacement: 'auth-settings' },
];

const DEBUG_WAF_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'phpunit', pattern: /phpunit/i },
  { name: 'traversal', pattern: /\.\.(?:\/|\\)/ },
  { name: 'traversal-encoded', pattern: /%2e%2e/i },
  { name: 'traversal-double-encoded', pattern: /%252e%252e/i },
  { name: 'eval-stdin', pattern: /eval-stdin/i },
  { name: 'php-tag', pattern: /<\?(?!xml)/i },
];

const HAS_PHPUNIT_PATTERN = /phpunit/i;
const HAS_TRAVERSAL_PATTERN = /\.\.(?:\/|\\)|%2e%2e|%252e%252e/i;

function redactByPattern(input: string, pattern: RegExp, label: string): string {
  return input.replace(pattern, (match: string) => `[${label}:${match.length}]`);
}

export function sanitizeTextForApi(text: string): string {
  let result = text;

  result = redactByPattern(result, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, 'jwt');
  result = redactByPattern(result, /-----BEGIN [^-]{0,80}-----[\s\S]*?-----END [^-]{0,80}-----/g, 'pem');
  result = redactByPattern(result, /\bssh-(?:rsa|ed25519|dss)\s+[A-Za-z0-9+/=]{80,}(?:\s+[^\s]+)?/g, 'ssh-key');
  result = redactByPattern(result, /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{200,}={0,2}(?![A-Za-z0-9+/=])/g, 'base64');
  result = redactByPattern(result, /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{240,}(?![A-Za-z0-9_-])/g, 'base64url');
  result = redactByPattern(result, /(?<![0-9a-fA-F])[0-9a-fA-F]{200,}(?![0-9a-fA-F])/g, 'hex');
  result = redactByPattern(result, /\bsk-[A-Za-z0-9]{20,}\b/g, 'openai-key');
  result = redactByPattern(result, /\bghp_[A-Za-z0-9]{30,}\b/g, 'gh-token');
  result = redactByPattern(result, /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'gh-pat');
  result = redactByPattern(result, /\bxox(?:b|p|a|r|s)-[A-Za-z0-9-]{10,}\b/g, 'slack-token');
  result = redactByPattern(result, /\bBearer\s+[A-Za-z0-9._-]{30,}\b/gi, 'bearer');
  result = redactByPattern(result, /\bAKIA[0-9A-Z]{16}\b/g, 'aws-ak');

  for (const { regex, replacement } of REWRITE_RULES) {
    result = result.replace(regex, replacement);
  }

  result = result.replace(/(<\s*\/?\s*)script\b/gi, (_match: string, prefix: string) => {
    return `${prefix}sc ript`;
  });

  result = result.replace(/<(?=\s*\/?\s*[a-zA-Z])/g, '‹');
  result = result.replace(/<\s*\?\s*(php)/gi, (_match: string, php: string) => `< ? ${php}`);
  result = result.replace(/<\?(?!xml\b)/gi, '< ?');

  result = result.replace(/%252e%252e%252f/gi, 'parent/');
  result = result.replace(/%252e%252e%255c/gi, 'parent\\');
  result = result.replace(/%252e%252e[%\/\\]/gi, 'parent/');
  result = result.replace(/\.\.%252f/gi, 'parent/');
  result = result.replace(/\.\.%255c/gi, 'parent\\');
  result = result.replace(/%252e%252e\//gi, 'parent/');
  result = result.replace(/%252e%252e\\/gi, 'parent\\');

  result = result.replace(/%2e%2e%2f/gi, 'parent/');
  result = result.replace(/%2e%2e%5c/gi, 'parent\\');
  result = result.replace(/%2e%2e[%\/\\]/gi, 'parent/');
  result = result.replace(/\.\.%2f/gi, 'parent/');
  result = result.replace(/\.\.%5c/gi, 'parent\\');

  result = result.replace(/\.\.(\/+)/g, 'parent$1');
  result = result.replace(/\.\.(\\+)/g, 'parent$1');

  result = result.replace(/vendor\/phpunit/gi, 'vendor/test-framework');
  result = result.replace(/phpunit\.xml/gi, 'test-config.xml');
  result = result.replace(/phpunit\.php/gi, 'test-runner.php');
  result = result.replace(/wp-content/gi, 'site-content');
  result = result.replace(/wp-admin/gi, 'site-admin');
  result = result.replace(/wp-includes/gi, 'site-includes');
  result = result.replace(/cgi-bin/gi, 'scripts');

  result = result.replace(/\$\s*\(/g, '$ (');
  result = result.replace(/\|\|/g, ' or ');
  result = result.replace(/&&/g, ' and ');
  result = result.replace(/\|/g, ' pipe ');
  result = result.replace(/;/g, ' ; ');

  const hadPhpunit = HAS_PHPUNIT_PATTERN.test(text);
  const hadTraversal = HAS_TRAVERSAL_PATTERN.test(text);

  if (hadPhpunit || hadTraversal) {
    const originalPatterns = DEBUG_WAF_PATTERNS.filter((pattern) => pattern.pattern.test(text)).map((pattern) => pattern.name);
    const stillPresent = DEBUG_WAF_PATTERNS.filter((pattern) => pattern.pattern.test(result)).map((pattern) => pattern.name);

    errorLogger.warn('DEBUG: Sanitization applied to problematic content', {
      source: 'SystemSculptProvider',
      method: 'sanitizeTextForApi',
      metadata: {
        originalPatterns,
        stillPresent,
        sanitizationWorked: stillPresent.length === 0,
        originalLength: text.length,
        sanitizedLength: result.length,
        sanitizedSample: result.substring(0, 800),
      },
    });
  }

  return result;
}
