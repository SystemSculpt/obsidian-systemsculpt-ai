/**
 * SystemSculptProvider - Default embeddings provider
 * 
 * Uses the SystemSculpt API for generating embeddings
 * with automatic retry logic and error handling
 */

import { httpRequest, isHostTemporarilyDisabled, HttpResponseShim } from '../../../utils/httpClient';
import { EmbeddingsProvider, EmbeddingsGenerateOptions, EmbeddingBatchMetadata } from '../types';
import { API_BASE_URL, SYSTEMSCULPT_API_ENDPOINTS, SYSTEMSCULPT_API_HEADERS } from '../../../constants/api';
import { resolveSystemSculptApiBaseUrl } from '../../../utils/urlHelpers';
import { tokenCounter } from '../../../utils/TokenCounter';
import { errorLogger } from '../../../utils/errorLogger';
import { EmbeddingsProviderError, EmbeddingsProviderErrorCode, isEmbeddingsProviderError } from './ProviderError';
import { DEFAULT_EMBEDDING_MODEL } from '../../../constants/embeddings';

export class SystemSculptProvider implements EmbeddingsProvider {
  readonly id = 'systemsculpt';
  readonly name = 'SystemSculpt';
  readonly supportsModels = false;
  
  private readonly defaultModel = DEFAULT_EMBEDDING_MODEL;
  private readonly maxRetries = 3;
  private readonly retryDelay = 1000;
  private readonly requestTimeoutMs = 90000; // Add explicit timeout to avoid silent hangs
  private readonly maxTextsPerRequest = 25;
  public lastModelChanged: boolean = false;
  private readonly baseUrl: string;
  private readonly embeddingsEndpoint = SYSTEMSCULPT_API_ENDPOINTS.EMBEDDINGS.GENERATE;
  private static readonly FORBIDDEN_LOG_WINDOW_MS = 60 * 1000;

  public expectedDimension: number | undefined;
  private forbiddenHtmlLastLogAt = 0;
  private forbiddenHtmlSuppressedDuplicates = 0;

  constructor(
    private licenseKey: string,
    baseUrl: string = API_BASE_URL,
    public model?: string
  ) {
    this.baseUrl = resolveSystemSculptApiBaseUrl(baseUrl);
    // Use the server-selected default so namespaces stay consistent
    this.model = DEFAULT_EMBEDDING_MODEL;
  }

  async generateEmbeddings(texts: string[], options?: EmbeddingsGenerateOptions): Promise<number[][]> {
    if (!this.licenseKey) {
      throw new Error('License key is required for SystemSculpt embeddings');
    }

    if (texts.length === 0) {
      return [];
    }

    // Validate and truncate texts
    const validTexts = texts
      .filter(text => text && typeof text === 'string' && text.trim().length > 0)
      .map(text => {
        const sanitized = this.sanitizeTextForApi(text);
        // Ensure each text is within token limits
        // Use a more conservative limit (5000 tokens) to account for server overhead
        const truncated = tokenCounter.truncateToTokenLimit(sanitized, 5000);
        return truncated;
      });

    if (validTexts.length === 0) {
      return [];
    }

    if (validTexts.length > this.maxTextsPerRequest) {
      return this.generateEmbeddingsInClientBatches(validTexts, options);
    }

    return this.performEmbeddingRequest(validTexts, options);
  }

  private sanitizeTextForApi(text: string): string {
    let result = text;

    // Redact high-entropy blobs (often useless for semantic search and can trigger WAF signatures).
    // Keep placeholders short to avoid inflating payload size.
    const redact = (pattern: RegExp, label: string) => {
      result = result.replace(pattern, (match: string) => `[${label}:${match.length}]`);
    };

    // JWTs (three base64url segments separated by dots)
    redact(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "jwt");

    // PEM blocks (private keys, certificates, etc.)
    redact(/-----BEGIN [^-]{0,80}-----[\s\S]*?-----END [^-]{0,80}-----/g, "pem");

    // SSH public keys
    redact(/\bssh-(?:rsa|ed25519|dss)\s+[A-Za-z0-9+/=]{80,}(?:\s+[^\s]+)?/g, "ssh-key");

    // Long base64 / base64url blobs
    redact(/(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{200,}={0,2}(?![A-Za-z0-9+/=])/g, "base64");
    redact(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{240,}(?![A-Za-z0-9_-])/g, "base64url");

    // Long hex blobs (hashes, dumps)
    redact(/(?<![0-9a-fA-F])[0-9a-fA-F]{200,}(?![0-9a-fA-F])/g, "hex");

    // Common API tokens and credentials
    redact(/\bsk-[A-Za-z0-9]{20,}\b/g, "openai-key");
    redact(/\bghp_[A-Za-z0-9]{30,}\b/g, "gh-token");
    redact(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "gh-pat");
    redact(/\bxox(?:b|p|a|r|s)-[A-Za-z0-9-]{10,}\b/g, "slack-token");
    redact(/\bBearer\s+[A-Za-z0-9._-]{30,}\b/gi, "bearer");
    redact(/\bAKIA[0-9A-Z]{16}\b/g, "aws-ak");

    // Some upstream CDNs/WAFs block requests based on exploit-signature keywords in the payload.
    // Rewrite a small set of high-signal signatures while preserving approximate semantics.
    const rewrites: Array<{ regex: RegExp; replacement: string }> = [
      { regex: /eval-stdin/gi, replacement: "input-handler" },
      { regex: /phpunit/gi, replacement: "test runner" },
      { regex: /\\think\\app/gi, replacement: "/framework/app" },
      { regex: /invokefunction/gi, replacement: "callmethod" },
      { regex: /call_user_func(?:_array)?/gi, replacement: "callback" },
      { regex: /pearcmd/gi, replacement: "pkg-manager" },
      { regex: /fgt_lang/gi, replacement: "fw-lang" },
      { regex: /sslvpn/gi, replacement: "secure-tunnel" },
      { regex: /\bcmdb\b/gi, replacement: "config-db" },
      { regex: /wp-file-manager/gi, replacement: "site-filemanager" },
      { regex: /sqlmap/gi, replacement: "db tool" },
      { regex: /\bnmap\b/gi, replacement: "network scanner" },
      { regex: /metasploit/gi, replacement: "security framework" },
      { regex: /hashcat/gi, replacement: "hash tool" },
      { regex: /\bhydra\b/gi, replacement: "auth tool" },
      { regex: /\bbase64_decode\b/gi, replacement: "decode" },
      { regex: /\bunion\s+select\b/gi, replacement: "query" },
      { regex: /\bcurl\b/gi, replacement: "http client" },
      { regex: /\bwget\b/gi, replacement: "downloader" },
      { regex: /\bpowershell\b/gi, replacement: "shell" },
      { regex: /\bcmd\.exe\b/gi, replacement: "shell" },
      { regex: /\brm\s+-rf\b/gi, replacement: "delete" },
      { regex: /\bchmod\b/gi, replacement: "permissions" },
      { regex: /\bchown\b/gi, replacement: "ownership" },
      { regex: /\/etc\/passwd\b/gi, replacement: "/system/users" },
      { regex: /\/etc\/shadow\b/gi, replacement: "/system/auth" },
      { regex: /\bxss\b/gi, replacement: "injection" },
      { regex: /\bcsrf\b/gi, replacement: "request forgery" },
      { regex: /\bsql\s+injection\b/gi, replacement: "query attack" },
      { regex: /\bCVE-\d{4}-\d{3,7}\b/gi, replacement: "[security-id]" },
      { regex: /\bexploit\b/gi, replacement: "vulnerability" },
      { regex: /\bpayload\b/gi, replacement: "data" },
      { regex: /\bshellcode\b/gi, replacement: "code" },
      { regex: /\bbackdoor\b/gi, replacement: "access" },
      { regex: /\brootkit\b/gi, replacement: "kit" },
      { regex: /\bkeylogger\b/gi, replacement: "logger" },
      { regex: /\bmalware\b/gi, replacement: "software" },
      { regex: /\btrojan\b/gi, replacement: "program" },
      { regex: /\bransomware\b/gi, replacement: "software" },
      { regex: /\bbotnet\b/gi, replacement: "network" },
      { regex: /\bddos\b/gi, replacement: "attack" },
      { regex: /\bbruteforce\b/gi, replacement: "attempt" },
      { regex: /\bbrute\s*-?\s*force\b/gi, replacement: "attempt" },
      { regex: /\beval\s*\(/gi, replacement: "evaluate(" },
      { regex: /\bexec\s*\(/gi, replacement: "execute(" },
      { regex: /\bsystem\s*\(/gi, replacement: "run(" },
      { regex: /\bpassthru\s*\(/gi, replacement: "pass(" },
      { regex: /\bshell_exec\s*\(/gi, replacement: "run(" },
      { regex: /\bproc_open\s*\(/gi, replacement: "process(" },
      { regex: /\bpopen\s*\(/gi, replacement: "open(" },
      { regex: /\bpcntl_exec\s*\(/gi, replacement: "run(" },
      { regex: /\bfile_get_contents\s*\(/gi, replacement: "read_file(" },
      { regex: /\bfopen\s*\(/gi, replacement: "open_file(" },
      { regex: /\binclude\s*\(/gi, replacement: "load(" },
      { regex: /\brequire\s*\(/gi, replacement: "load(" },
      { regex: /\binclude_once\s*\(/gi, replacement: "load(" },
      { regex: /\brequire_once\s*\(/gi, replacement: "load(" },
      { regex: /\bpreg_replace\s*\([^)]*\/e/gi, replacement: "regex_replace(" },
      { regex: /\bassert\s*\(/gi, replacement: "check(" },
      { regex: /\bcreate_function\s*\(/gi, replacement: "make_func(" },
      { regex: /\b\$_(?:GET|POST|REQUEST|COOKIE|SERVER|FILES)\b/gi, replacement: "$input" },
      { regex: /\bLog4Shell\b/gi, replacement: "logging vulnerability" },
      { regex: /\bShellshock\b/gi, replacement: "bash vulnerability" },
      { regex: /\bHeartbleed\b/gi, replacement: "ssl vulnerability" },
      { regex: /\bpentesting?\b/gi, replacement: "security testing" },
      { regex: /\bpentest\b/gi, replacement: "security test" },
      { regex: /\bpen-?test(?:ing|er)?\b/gi, replacement: "security test" },
      { regex: /\bvuln(?:erability|erable)?\b/gi, replacement: "issue" },
      { regex: /\binjection\b/gi, replacement: "input issue" },
      { regex: /\bRCE\b/g, replacement: "remote issue" },
      { regex: /\bLFI\b/g, replacement: "file issue" },
      { regex: /\bRFI\b/g, replacement: "file issue" },
      { regex: /\bSSRF\b/g, replacement: "request issue" },
      { regex: /\bSSTI\b/g, replacement: "template issue" },
      { regex: /\bIDOR\b/g, replacement: "access issue" },
      { regex: /\b0day\b/gi, replacement: "new issue" },
      { regex: /\bzero[- ]?day\b/gi, replacement: "new issue" },
      { regex: /\bfuzzing?\b/gi, replacement: "testing" },
      { regex: /\bfuzzer\b/gi, replacement: "tester" },
      { regex: /\bbug\s*bounty\b/gi, replacement: "security program" },
      { regex: /\bhack(?:ing|er|ed)?\b/gi, replacement: "access" },
      { regex: /\bcrack(?:ing|er|ed)?\b/gi, replacement: "break" },
      { regex: /\bbypass(?:ing|ed)?\b/gi, replacement: "circumvent" },
      { regex: /\bescape\s+sequence\b/gi, replacement: "special chars" },
      { regex: /\bnull\s*byte\b/gi, replacement: "zero char" },
      { regex: /\bpoison(?:ing|ed)?\b/gi, replacement: "corrupt" },
      { regex: /\bspoof(?:ing|ed)?\b/gi, replacement: "fake" },
      { regex: /\bsniff(?:ing|er|ed)?\b/gi, replacement: "monitor" },
      { regex: /\breverse\s+shell\b/gi, replacement: "remote connection" },
      { regex: /\bbind\s+shell\b/gi, replacement: "listener" },
      { regex: /\bweb\s*shell\b/gi, replacement: "web tool" },
      { regex: /\bC2\b/g, replacement: "server" },
      { regex: /\bcommand\s+and\s+control\b/gi, replacement: "remote server" },
      { regex: /\bbash\s+-[ci]\b/gi, replacement: "shell" },
      { regex: /\bsh\s+-[ci]\b/gi, replacement: "shell" },
      { regex: /\/bin\/(?:ba)?sh\b/gi, replacement: "/shell" },
      { regex: /\/usr\/bin\/(?:ba)?sh\b/gi, replacement: "/shell" },
      { regex: /\bnetcat\b/gi, replacement: "network tool" },
      { regex: /\bnc\s+-[lnvpe]/gi, replacement: "network tool" },
      { regex: /\bsocat\b/gi, replacement: "network tool" },
      { regex: /\btelnet\b/gi, replacement: "network tool" },
      { regex: /\bnslookup\b/gi, replacement: "dns tool" },
      { regex: /\bdig\b/gi, replacement: "dns tool" },
      { regex: /\bhost\s+[^\s]+/gi, replacement: "dns lookup" },
      { regex: /\bwhois\b/gi, replacement: "domain tool" },
      { regex: /\btraceroute\b/gi, replacement: "network path" },
      { regex: /\bping\s+-[cn]/gi, replacement: "network check" },
      { regex: /\bsudo\b/gi, replacement: "elevated" },
      { regex: /\bsu\s+-?\s*\w/gi, replacement: "switch user" },
      { regex: /\bpasswd\b/gi, replacement: "password" },
      { regex: /\bshadow\b/gi, replacement: "auth" },
      { regex: /\b(?:my)?sql\s+-[uphe]/gi, replacement: "db connect" },
      { regex: /\bmongo(?:db)?\s+--/gi, replacement: "db connect" },
      { regex: /\bredis-cli\b/gi, replacement: "cache client" },
      { regex: /\bpsql\b/gi, replacement: "db client" },
      { regex: /\bsqlite3?\b/gi, replacement: "db" },
      { regex: /\bawk\s+['"{]/gi, replacement: "text process" },
      { regex: /\bsed\s+-[eni]/gi, replacement: "text process" },
      { regex: /\bgrep\s+-[rniEP]/gi, replacement: "search" },
      { regex: /\bfind\s+\/\s+-/gi, replacement: "search /" },
      { regex: /\bxargs\b/gi, replacement: "args" },
      { regex: /\|\s*base64\b/gi, replacement: " pipe encode" },
      { regex: /\bbase64\s+-d\b/gi, replacement: "decode" },
      { regex: /\b(?:en|de)code\s+base64\b/gi, replacement: "transform" },
      { regex: /\btar\s+-[xzcvf]/gi, replacement: "archive" },
      { regex: /\bunzip\b/gi, replacement: "extract" },
      { regex: /\bgzip\b/gi, replacement: "compress" },
      { regex: /\bdd\s+if=/gi, replacement: "copy data" },
      { regex: /\bcat\s*>\s*[^\s]+/gi, replacement: "write file" },
      { regex: /\becho\s+[^>]{1,40}>/gi, replacement: "write " },
      { regex: />\s*\/dev\/(?:null|tcp|udp)/gi, replacement: "> output" },
      { regex: /\/dev\/tcp\/[^\s]+/gi, replacement: "/network" },
      { regex: /\/dev\/udp\/[^\s]+/gi, replacement: "/network" },
      { regex: /\bcrontab\b/gi, replacement: "scheduler" },
      { regex: /\/etc\/cron/gi, replacement: "/system/scheduler" },
      { regex: /\.htaccess\b/gi, replacement: "config" },
      { regex: /\.htpasswd\b/gi, replacement: "auth-config" },
      { regex: /web\.config\b/gi, replacement: "config" },
      { regex: /\.env\b(?!iron)/gi, replacement: "config" },
      { regex: /config\.(?:php|yml|yaml|json|xml|ini)\b/gi, replacement: "settings" },
      { regex: /database\.(?:php|yml|yaml|json|xml)\b/gi, replacement: "db-settings" },
      { regex: /credentials?\.(?:php|yml|yaml|json|xml)\b/gi, replacement: "auth-settings" },
      { regex: /secrets?\.(?:php|yml|yaml|json|xml)\b/gi, replacement: "auth-settings" },
    ];

    for (const { regex, replacement } of rewrites) {
      result = result.replace(regex, replacement);
    }

    // Defang common executable/script tags.
    result = result.replace(/(<\s*\/?\s*)script\b/gi, (_match: string, prefix: string) => {
      return `${prefix}sc ript`;
    });

    // Defang generic tag-like markup to avoid WAF/XSS signature matches while preserving readability.
    result = result.replace(/<(?=\s*\/?\s*[a-zA-Z])/g, "‹");

    // Defang PHP open tags (handles <?php, < ?php, <? php, <?echo, <?=, etc.).
    // First handle <?php variants
    result = result.replace(/<\s*\?\s*(php)/gi, (_match: string, php: string) => `< ? ${php}`);
    // Then handle short open tags like <?echo, <?=, but NOT <?xml
    result = result.replace(/<\?(?!xml\b)/gi, "< ?");

    // Defang common traversal / injection signatures (including URL-encoded variants).
    // Double-encoded patterns first (%252e = double-encoded dot, %252f = double-encoded /)
    result = result.replace(/%252e%252e%252f/gi, 'parent/');
    result = result.replace(/%252e%252e%255c/gi, 'parent\\');
    result = result.replace(/%252e%252e[%\/\\]/gi, 'parent/');
    result = result.replace(/\.\.%252f/gi, 'parent/');
    result = result.replace(/\.\.%255c/gi, 'parent\\');
    result = result.replace(/%252e%252e\//gi, 'parent/');
    result = result.replace(/%252e%252e\\/gi, 'parent\\');
    // Single URL-encoded patterns
    result = result.replace(/%2e%2e%2f/gi, 'parent/');
    result = result.replace(/%2e%2e%5c/gi, 'parent\\');
    result = result.replace(/%2e%2e[%\/\\]/gi, 'parent/');
    result = result.replace(/\.\.%2f/gi, 'parent/');
    result = result.replace(/\.\.%5c/gi, 'parent\\');
    // Plain traversal patterns
    result = result.replace(/\.\.(\/+)/g, 'parent$1');
    result = result.replace(/\.\.(\\+)/g, 'parent$1');

    // Defang common file paths that trigger WAF rules.
    result = result.replace(/vendor\/phpunit/gi, 'vendor/test-framework');
    result = result.replace(/phpunit\.xml/gi, 'test-config.xml');
    result = result.replace(/phpunit\.php/gi, 'test-runner.php');
    result = result.replace(/wp-content/gi, 'site-content');
    result = result.replace(/wp-admin/gi, 'site-admin');
    result = result.replace(/wp-includes/gi, 'site-includes');
    result = result.replace(/cgi-bin/gi, 'scripts');

    // Defang common operator patterns used in payloads without deleting meaning entirely.
    result = result.replace(/\$\s*\(/g, "$ (");
    result = result.replace(/\|\|/g, " or ");
    result = result.replace(/&&/g, " and ");
    result = result.replace(/\|/g, " pipe ");
    result = result.replace(/;/g, " ; ");

    // DEBUG: Always log sanitization for texts with known-bad patterns in original
    const hadPhpunit = /phpunit/i.test(text);
    const hadTraversal = /\.\.(?:\/|\\)|%2e%2e|%252e%252e/i.test(text);

    if (hadPhpunit || hadTraversal) {
      const wafPatterns = [
        { name: 'phpunit', pattern: /phpunit/i },
        { name: 'traversal', pattern: /\.\.(?:\/|\\)/ },
        { name: 'traversal-encoded', pattern: /%2e%2e/i },
        { name: 'traversal-double-encoded', pattern: /%252e%252e/i },
        { name: 'eval-stdin', pattern: /eval-stdin/i },
        { name: 'php-tag', pattern: /<\?(?!xml)/i },
      ];
      const originalPatterns = wafPatterns.filter(p => p.pattern.test(text)).map(p => p.name);
      const stillPresent = wafPatterns.filter(p => p.pattern.test(result)).map(p => p.name);

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
        }
      });
    }

    return result;
  }

  private async generateEmbeddingsInClientBatches(
    validTexts: string[],
    options?: EmbeddingsGenerateOptions
  ): Promise<number[][]> {
    const batches = this.splitClientBatches(validTexts, options?.batchMetadata);

    if (batches.length === 0) {
      return [];
    }

    try {
      errorLogger.warn('SystemSculpt embeddings input exceeded client batch limit; splitting into safe batches', {
        source: 'SystemSculptProvider',
        method: 'generateEmbeddings',
        providerId: this.id,
        metadata: {
          totalTexts: validTexts.length,
          maxTextsPerRequest: this.maxTextsPerRequest,
          inputType: options?.inputType || 'document',
          segments: batches.length,
        },
      });
    } catch {}

    const aggregated: number[][] = [];

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const segmentOptions: EmbeddingsGenerateOptions | undefined = batch.metadata
        ? { ...(options ?? {}), batchMetadata: batch.metadata }
        : options;

      const embeddings = await this.performEmbeddingRequest(batch.texts, segmentOptions, {
        segmentIndex: i,
        segmentCount: batches.length,
      });
      aggregated.push(...embeddings);
    }

    return aggregated;
  }

  private handleForbiddenHtmlResponse(
    error: EmbeddingsProviderError,
    metadata: Record<string, unknown>,
    responseText?: string
  ): EmbeddingsProviderError {
    const now = Date.now();
    const shouldLogFull = now - this.forbiddenHtmlLastLogAt > SystemSculptProvider.FORBIDDEN_LOG_WINDOW_MS;

    if (shouldLogFull) {
      if (this.forbiddenHtmlSuppressedDuplicates > 0) {
        errorLogger.warn('SystemSculpt embeddings 403 HTML persisted; suppressed duplicate logs', {
          source: 'SystemSculptProvider',
          method: 'generateEmbeddings',
          providerId: this.id,
          metadata: {
            ...metadata,
            suppressedDuplicates: this.forbiddenHtmlSuppressedDuplicates,
          }
        });
        this.forbiddenHtmlSuppressedDuplicates = 0;
      }
      const fallbackText = responseText || (typeof (error.details as any)?.fullText === 'string'
        ? (error.details as any).fullText as string
        : 'No response text available');
      errorLogger.error('=== HTTP 403 FORBIDDEN ERROR - FULL RESPONSE DETAILS ===', error, {
        source: 'SystemSculptProvider',
        method: 'generateEmbeddings',
        providerId: this.id,
        metadata: {
          ...metadata,
          fullResponseText: fallbackText,
          fullResponseLength: fallbackText.length,
        }
      });
      this.forbiddenHtmlLastLogAt = now;
    } else {
      this.forbiddenHtmlSuppressedDuplicates += 1;
    }

    return new EmbeddingsProviderError(error.message, {
      code: 'HOST_UNAVAILABLE',
      status: error.status ?? 403,
      retryInMs: error.retryInMs,
      transient: true,
      providerId: error.providerId ?? this.id,
      endpoint: error.endpoint ?? this.getEndpointUrl(),
      details: {
        ...(error.details || {}),
        suppressionWindowMs: SystemSculptProvider.FORBIDDEN_LOG_WINDOW_MS
      },
      cause: error
    });
  }


  private splitClientBatches(
    texts: string[],
    metadata?: EmbeddingBatchMetadata
  ): Array<{ texts: string[]; metadata?: EmbeddingBatchMetadata }> {
    const batches: Array<{ texts: string[]; metadata?: EmbeddingBatchMetadata }> = [];
    if (!Array.isArray(texts) || texts.length === 0) {
      return batches;
    }

    for (let start = 0; start < texts.length; start += this.maxTextsPerRequest) {
      const slice = texts.slice(start, start + this.maxTextsPerRequest);
      const sliceMeta = this.sliceBatchMetadata(metadata, start, slice.length);
      batches.push({ texts: slice, metadata: sliceMeta });
    }

    return batches;
  }

  private isHtmlResponseError(error: EmbeddingsProviderError): boolean {
    const details = error.details as Record<string, unknown> | undefined;
    return typeof details?.kind === 'string' && details.kind === 'html-response';
  }

  private async performEmbeddingRequest(
    validTexts: string[],
    options?: EmbeddingsGenerateOptions,
    segmentContext?: { segmentIndex: number; segmentCount: number }
  ): Promise<number[][]> {
    const payloadTexts = validTexts;
    const batchSummary = this.summarizeBatchMetadata(options?.batchMetadata);
    const textStats = payloadTexts.map((text, idx) => ({
      index: idx,
      length: text.length,
      estimatedTokens: tokenCounter.estimateTokens(text)
    }));
    const totalEstimatedTokens = textStats.reduce((sum, stat) => sum + stat.estimatedTokens, 0);
    const maxEstimatedTokens = textStats.reduce((max, stat) => Math.max(max, stat.estimatedTokens), 0);

    errorLogger.debug('SystemSculpt embeddings payload prepared', {
      source: 'SystemSculptProvider',
      method: 'generateEmbeddings',
      providerId: this.id,
      metadata: {
        inputType: options?.inputType || 'document',
        textCount: textStats.length,
        totalEstimatedTokens,
        maxEstimatedTokens,
        batch: batchSummary,
        segment: segmentContext
      }
    });

    const oversizedTexts = textStats.filter(stat => stat.estimatedTokens > 8000);
    if (oversizedTexts.length > 0) {
      errorLogger.warn('SystemSculpt embeddings inputs exceeded conservative token budget; truncation applied', {
        source: 'SystemSculptProvider',
        method: 'generateEmbeddings',
        providerId: this.id,
        metadata: {
          oversizedCount: oversizedTexts.length,
          maxEstimatedTokens: Math.max(...oversizedTexts.map(stat => stat.estimatedTokens)),
          batch: batchSummary,
          segment: segmentContext
        }
      });
    }

    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      const url = this.getEndpointUrl();
      const hostStatus = isHostTemporarilyDisabled(url);
      if (hostStatus.disabled) {
        const retryMs = Math.max(1000, hostStatus.retryInMs || 0);
        throw new EmbeddingsProviderError(
          `Embeddings host temporarily unavailable. Retry in ${retryMs}ms`,
          {
            code: 'HOST_UNAVAILABLE',
            providerId: this.id,
            endpoint: url,
            retryInMs: retryMs,
            transient: true,
            status: 0,
          }
        );
      }

      try {
        const requestHeaders = {
          ...SYSTEMSCULPT_API_HEADERS.WITH_LICENSE(this.licenseKey),
          'Idempotency-Key': this.buildIdempotencyKey(
            payloadTexts,
            this.model || this.defaultModel,
            options?.inputType || 'document'
          ),
        };
        // Lightweight idempotency key: stable hash of concatenated inputs + model + inputType
        // Server expects 'texts' for batch requests
        const requestBody = {
          texts: payloadTexts,
          model: this.model || this.defaultModel,
          inputType: options?.inputType || 'document',
          // Provide currentModel to allow server to flag migrations
          currentModel: this.model || this.defaultModel
        };

        
        const response = await httpRequest({
          url,
          method: 'POST',
          headers: requestHeaders,
          body: JSON.stringify(requestBody),
          timeoutMs: this.requestTimeoutMs
        });

        if (!response.status || response.status !== 200) {
          throw this.buildHttpError(response, url, segmentContext, batchSummary, validTexts.length);
        }

        const raw = typeof response.text === 'string' ? response.text : '';
        let data: any = undefined;
        try { data = raw ? JSON.parse(raw) : undefined; } catch {}

        if (!data || (!data.embeddings && !data.embedding)) {
          throw new EmbeddingsProviderError(
            'Invalid response format: missing embeddings array',
            {
              code: 'UNEXPECTED_RESPONSE',
              providerId: this.id,
              endpoint: url,
            }
          );
        }

        // Adopt server-selected model and flag migrations when signaled
        if (typeof data.model === 'string' && data.model.length > 0) {
          this.model = data.model;
        }
        this.lastModelChanged = !!data.modelChanged;

        // Track the dimension we actually receive to inform downstream validation
        const sampleEmbedding = Array.isArray(data.embeddings) && data.embeddings.length > 0
          ? data.embeddings[0]
          : (Array.isArray(data.embedding) ? data.embedding : null);
        const sampleDim = Array.isArray(sampleEmbedding) ? sampleEmbedding.length : 0;
        if (Number.isFinite(sampleDim) && sampleDim > 0) {
          this.expectedDimension = sampleDim;
        }

        // Support single or batch responses
        if (Array.isArray(data.embeddings)) return data.embeddings;
        if (Array.isArray(data.embedding)) return [data.embedding];
        return [];

      } catch (error) {
        let normalized = this.normalizeError(error, url);
        lastError = normalized;
        const status = normalized.status;
        const htmlSample = typeof (normalized.details as any)?.sample === 'string'
          ? (normalized.details as any).sample
          : undefined;
        if (status && (status === 502 || status === 503 || status === 504)) {
          try {
            errorLogger.warn('SystemSculpt embeddings API gateway error', {
              source: 'SystemSculptProvider',
              method: 'generateEmbeddings',
              providerId: this.id,
              metadata: {
                status,
                attempt,
                maxRetries: this.maxRetries,
                texts: validTexts.length,
                baseUrl: this.baseUrl,
                batch: batchSummary,
                segment: segmentContext
              }
            });
          } catch {}
        }
        // If host circuit is open or clear network refusal, break early to avoid spam
        const isCircuit = normalized.code === 'HOST_UNAVAILABLE';
        const refused = normalized.code === 'NETWORK_ERROR';
        const fullResponseText = typeof (normalized.details as any)?.fullText === 'string'
          ? (normalized.details as any).fullText
          : undefined;
        const attemptMetadata = {
          attempt,
          maxRetries: this.maxRetries,
          providerId: this.id,
          endpoint: url,
          status,
          code: normalized.code,
          retryInMs: normalized.retryInMs,
          payload: {
            textCount: textStats.length,
            totalEstimatedTokens,
            maxEstimatedTokens
          },
          batch: batchSummary,
          segment: segmentContext,
          htmlSample
        };

        let handledForbiddenHtml = false;
        if (status === 403 && this.isHtmlResponseError(normalized)) {
          normalized = this.handleForbiddenHtmlResponse(
            normalized,
            attemptMetadata,
            fullResponseText || htmlSample
          );
          lastError = normalized;
          handledForbiddenHtml = true;
        }

        if (!handledForbiddenHtml) {
          if (attempt < this.maxRetries && !isCircuit && !refused) {
            errorLogger.warn('SystemSculpt embeddings request failed; retrying', {
              source: 'SystemSculptProvider',
              method: 'generateEmbeddings',
              providerId: this.id,
              metadata: attemptMetadata
            });
          } else {
            errorLogger.error('SystemSculpt embeddings request failed', normalized, {
              source: 'SystemSculptProvider',
              method: 'generateEmbeddings',
              providerId: this.id,
              metadata: attemptMetadata
            });
          }
        }
        // Stop immediately on auth/license errors - no point retrying
        const isAuthError = normalized.code === 'LICENSE_INVALID' || status === 401 || status === 403;
        if (isCircuit || isAuthError) break;
        if (attempt < this.maxRetries && !isCircuit) {
          // Only retry once on networkish errors
          if (refused && attempt >= 2) break;
          await this.delay(this.retryDelay * attempt);
        }
      }
    }

    if (lastError) {
      throw lastError;
    }
    throw new EmbeddingsProviderError('Failed to generate embeddings after retries', {
      code: 'NETWORK_ERROR',
      providerId: this.id,
      endpoint: this.getEndpointUrl(),
      transient: true
    });
  }

  private getEndpointUrl(): string {
    return `${this.baseUrl}${this.embeddingsEndpoint}`;
  }

  private summarizeBatchMetadata(meta?: EmbeddingBatchMetadata | null): Record<string, unknown> | undefined {
    if (!meta) return undefined;
    const sampleItems = meta.items.slice(0, 10).map(item => ({
      path: item.path,
      chunkId: item.chunkId,
      processedLength: item.processedLength,
      estimatedTokens: item.estimatedTokens,
      truncated: item.truncated
    }));
    return {
      batchIndex: meta.batchIndex,
      batchSize: meta.batchSize,
      estimatedTotalTokens: meta.estimatedTotalTokens,
      maxEstimatedTokens: meta.maxEstimatedTokens,
      truncatedCount: meta.truncatedCount,
      sampleItems
    };
  }

  private sliceBatchMetadata(
    meta: EmbeddingBatchMetadata | undefined,
    start: number,
    count: number
  ): EmbeddingBatchMetadata | undefined {
    if (!meta) return undefined;
    if (count <= 0) return undefined;
    const items = meta.items.slice(start, start + count);
    if (items.length === 0) return undefined;

    const estimatedTotalTokens = items.reduce((sum, item) => sum + item.estimatedTokens, 0);
    const maxEstimatedTokens = items.reduce((max, item) => Math.max(max, item.estimatedTokens), 0);
    const truncatedCount = items.reduce((total, item) => total + (item.truncated ? 1 : 0), 0);

    return {
      batchIndex: meta.batchIndex,
      batchSize: items.length,
      estimatedTotalTokens,
      maxEstimatedTokens,
      truncatedCount,
      items
    };
  }

  private buildIdempotencyKey(texts: string[], model: string, inputType: 'document' | 'query'): string {
    // Non-cryptographic stable hash to keep fast on client
    let hash = 2166136261;
    const add = (s: string) => {
      for (let i = 0; i < s.length; i++) {
        hash ^= s.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
      }
    };
    add(model + '|' + inputType + '|');
    for (const t of texts) add(t);
    return (hash >>> 0).toString(36);
  }

  async validateConfiguration(): Promise<boolean> {
    try {
      // Test with a simple embedding
      await this.generateEmbeddings(['test']);
      return true;
    } catch (error) {
      return false;
    }
  }

  async getModels(): Promise<string[]> {
    // The server dictates the single supported embeddings model
    return [DEFAULT_EMBEDDING_MODEL];
  }

  getMaxBatchSize(): number {
    return this.maxTextsPerRequest;
  }

  private parseErrorResponse(response: HttpResponseShim | any): {
    message: string;
    retryInMs?: number;
    details?: Record<string, unknown>;
    isHtml: boolean;
  } {
    const status = typeof response?.status === 'number' ? response.status : undefined;
    const text = typeof response?.text === 'string' ? response.text : '';
    const trimmed = text ? text.trim() : '';
    const contentType = this.getHeaderValue(response?.headers, 'content-type');
    const lowerTrimmed = trimmed.toLowerCase();
    const isHtml = (contentType && contentType.toLowerCase().includes('text/html'))
      || lowerTrimmed.startsWith('<!doctype html')
      || lowerTrimmed.startsWith('<html')
      || trimmed.startsWith('<');

    let message: string | undefined;

    if (status && (status === 502 || status === 503 || status === 504)) {
      message = isHtml
        ? `SystemSculpt API is temporarily unavailable (HTTP ${status}). The upstream service returned a gateway error page instead of JSON.`
        : `SystemSculpt API is temporarily unavailable (HTTP ${status}). Retry shortly.`;
    } else if (isHtml) {
      const statusLabel = status ? ` (HTTP ${status})` : '';
      message = `Received HTML${statusLabel} instead of JSON from the SystemSculpt API. This usually means a gateway or CDN page was returned.`;
    } else {
      const structured = typeof response?.json === 'object' && response?.json !== null
        ? response.json
        : undefined;

      if (structured && typeof structured === 'object') {
        const messageField = (structured as any).message;
        const errorField = (structured as any).error;
        const trimmedMessage = typeof messageField === 'string' ? messageField.trim() : '';
        const trimmedError = typeof errorField === 'string' ? errorField.trim() : '';
        if (trimmedMessage && trimmedError && trimmedMessage.toLowerCase() !== trimmedError.toLowerCase()) {
          message = `${trimmedMessage} (${trimmedError})`;
        } else if (trimmedMessage) {
          message = trimmedMessage;
        } else if (trimmedError) {
          message = trimmedError;
        }
      }

      if (!message && trimmed.length > 0) {
        try {
          const errorData = text ? JSON.parse(text) : undefined;
          if (errorData && typeof errorData === 'object') {
            const parsedMessage = typeof (errorData as any).message === 'string' ? (errorData as any).message.trim() : '';
            const parsedError = typeof (errorData as any).error === 'string' ? (errorData as any).error.trim() : '';
            if (parsedMessage && parsedError && parsedMessage.toLowerCase() !== parsedError.toLowerCase()) {
              message = `${parsedMessage} (${parsedError})`;
            } else if (parsedMessage) {
              message = parsedMessage;
            } else if (parsedError) {
              message = parsedError;
            } else {
              message = trimmed;
            }
          }
        } catch {
          message = trimmed;
        }
      }
    }

    if (!message || message.length === 0) {
      message = status ? `HTTP ${status}` : 'Unknown error';
    }

    const retryInMs = this.parseRetryAfter(response?.headers);
    let details = typeof response?.json === 'object' && response?.json !== null
      ? { ...(response.json as Record<string, unknown>) }
      : undefined;

    if (isHtml) {
      const sample = trimmed.substring(0, 160);
      const htmlDetails: Record<string, unknown> = {
        kind: 'html-response',
        sample,
        fullText: trimmed,
      };
      details = details ? { ...htmlDetails, ...details } : htmlDetails;
    } else if (trimmed.length > 0) {
      if (!details) {
        details = {};
      }
      details.fullText = trimmed;
    }

    return { message, retryInMs, details, isHtml };
  }

  private getHeaderValue(headers: any, name: string): string | undefined {
    if (!headers || typeof headers !== 'object') {
      return undefined;
    }
    const entries = Array.isArray(headers)
      ? headers
      : Object.entries(headers);
    const lowerName = name.toLowerCase();
    for (const entry of entries as Array<[string, any]>) {
      const [key, value] = entry;
      if (typeof key === 'string' && key.toLowerCase() === lowerName) {
        if (Array.isArray(value)) {
          return typeof value[0] === 'string' ? value[0] : undefined;
        }
        if (typeof value === 'string') {
          return value;
        }
      }
    }
    return undefined;
  }

  private parseRetryAfter(headers: any): number | undefined {
    const headerValue = this.getHeaderValue(headers, 'retry-after');
    if (!headerValue) return undefined;

    const numeric = Number(headerValue);
    if (!Number.isNaN(numeric) && numeric >= 0) {
      return numeric * 1000;
    }

    const absolute = Date.parse(headerValue);
    if (!Number.isNaN(absolute)) {
      const diff = absolute - Date.now();
      if (diff > 0) {
        return diff;
      }
    }

    return undefined;
  }

  private buildHttpError(
    response: HttpResponseShim,
    requestUrl: string,
    segmentContext?: { segmentIndex: number; segmentCount: number },
    batchSummary?: Record<string, unknown>,
    textCount?: number
  ): EmbeddingsProviderError {
    const parsed = this.parseErrorResponse(response);
    const { message, retryInMs, details, isHtml } = parsed;
    const status = typeof response?.status === 'number' ? response.status : undefined;
    const code = this.classifyErrorCode(status, message, isHtml);
    const mergedDetails: Record<string, unknown> | undefined = (() => {
      if (!details && !batchSummary && typeof textCount !== 'number' && !segmentContext) {
        return details;
      }
      const merged: Record<string, unknown> = { ...(details ?? {}) };
      if (batchSummary) merged.batch = batchSummary;
      if (typeof textCount === 'number') merged.textCount = textCount;
      if (segmentContext) merged.segment = segmentContext;
      return merged;
    })();
    return new EmbeddingsProviderError(
      `API error ${status ?? 0}: ${message}`,
      {
        code,
        status,
        retryInMs,
        transient: this.isTransientStatus(status),
        licenseRelated: code === 'LICENSE_INVALID',
        providerId: this.id,
        endpoint: requestUrl,
        details: mergedDetails,
        cause: response
      }
    );
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private classifyErrorCode(status: number | undefined, message: string, isHtml?: boolean): EmbeddingsProviderErrorCode {
    if (isHtml) {
      if (status === 403 || (typeof status === 'number' && status >= 500)) {
        return 'HOST_UNAVAILABLE';
      }
      return 'INVALID_RESPONSE';
    }
    if (status === 401 || status === 402) {
      return 'LICENSE_INVALID';
    }
    if (status === 403) {
      return 'LICENSE_INVALID';
    }
    if (status === 429) {
      return 'RATE_LIMITED';
    }
    if (status === 0) {
      return 'NETWORK_ERROR';
    }
    if (!status && this.looksNetworkError(message)) {
      return 'NETWORK_ERROR';
    }
    const lower = message.toLowerCase();
    if (lower.includes('temporarily unavailable')) {
      return 'HOST_UNAVAILABLE';
    }
    if (status && status >= 400) {
      return 'HTTP_ERROR';
    }
    return 'NETWORK_ERROR';
  }

  private isTransientStatus(status?: number): boolean {
    if (typeof status !== 'number') return false;
    if (status >= 500) return true;
    if (status === 408 || status === 429) return true;
    return false;
  }

  private looksNetworkError(message: string): boolean {
    const lower = message.toLowerCase();
    return lower.includes('net::err')
      || lower.includes('econn')
      || lower.includes('enotfound')
      || lower.includes('timeout')
      || lower.includes('timed out')
      || lower.includes('network');
  }

  private extractErrorMessage(error: unknown): string {
    if (isEmbeddingsProviderError(error)) {
      return error.message;
    }
    if (error && typeof error === 'object' && ('status' in error || 'text' in error || 'json' in error)) {
      try {
        const parsed = this.parseErrorResponse(error as any);
        if (parsed.message) return parsed.message;
      } catch {}
    }
    if (error instanceof Error && typeof error.message === 'string' && error.message.length > 0) {
      return error.message;
    }
    const fallback = (error as any)?.message;
    if (typeof fallback === 'string' && fallback.length > 0) {
      return fallback;
    }
    return 'SystemSculpt API request failed';
  }

  private extractErrorDetails(error: unknown): Record<string, unknown> | undefined {
    if (!error || typeof error !== 'object') {
      return undefined;
    }
    const maybe = error as any;
    const details: Record<string, unknown> = {};
    if (typeof maybe.status === 'number') {
      details.status = maybe.status;
    }
    if (typeof maybe.text === 'string' && maybe.text.trim().length > 0) {
      details.text = maybe.text.trim().slice(0, 4000);
    }
    if (typeof maybe.json === 'object' && maybe.json !== null) {
      details.json = maybe.json;
    }
    if (typeof maybe.details === 'object' && maybe.details !== null) {
      const inner = maybe.details as Record<string, unknown>;
      if (typeof inner.kind === 'string') {
        details.kind = inner.kind;
      }
      if (typeof inner.sample === 'string') {
        details.sample = inner.sample;
      }
    }
    if (Object.keys(details).length === 0) {
      return undefined;
    }
    return details;
  }

  private normalizeError(error: unknown, requestUrl: string): EmbeddingsProviderError {
    if (isEmbeddingsProviderError(error)) {
      return error;
    }

    const status = typeof (error as any)?.status === "number" ? (error as any).status : undefined;
    const retryInMsRaw = typeof (error as any)?.retryInMs === "number" ? (error as any).retryInMs : undefined;

    const maybe = error as any;
    const hasResponseText = typeof maybe?.text === "string" && maybe.text.trim().length > 0;
    const hasResponseJson = typeof maybe?.json === "object" && maybe.json !== null;
    const hasResponseHeaders = typeof maybe?.headers === "object" && maybe.headers !== null;
    const hasResponseShape = !!(error && typeof error === "object" && (hasResponseText || hasResponseJson || hasResponseHeaders));

    let parsedResponse:
      | { message: string; retryInMs?: number; details?: Record<string, unknown>; isHtml: boolean }
      | undefined;
    if (hasResponseShape) {
      try {
        parsedResponse = this.parseErrorResponse(maybe);
      } catch {}
    }

    const retryInMsParsed = typeof parsedResponse?.retryInMs === "number" ? parsedResponse.retryInMs : undefined;
    const retryInMs = retryInMsRaw && retryInMsRaw > 0
      ? retryInMsRaw
      : retryInMsParsed && retryInMsParsed > 0
        ? retryInMsParsed
        : undefined;

    const details = parsedResponse?.details ?? this.extractErrorDetails(error);
    const baseMessage = parsedResponse?.message ?? this.extractErrorMessage(error);
    const message =
      typeof status === "number" && status > 0
        ? `API error ${status}: ${baseMessage}`
        : baseMessage;
    const isHtml = parsedResponse?.isHtml ?? (typeof details?.kind === "string" && details.kind === "html-response");
    const code = this.classifyErrorCode(status, baseMessage, isHtml);
    const transient = this.isTransientStatus(status) || code === 'NETWORK_ERROR' || code === 'HOST_UNAVAILABLE';
    const licenseRelated = code === 'LICENSE_INVALID';

    return new EmbeddingsProviderError(message, {
      code,
      status,
      retryInMs,
      transient,
      licenseRelated,
      providerId: this.id,
      endpoint: requestUrl,
      details,
      cause: error
    });
  }
}
