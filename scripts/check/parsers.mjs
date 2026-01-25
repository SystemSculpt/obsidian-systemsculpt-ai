import path from 'node:path';

const tsDiagnosticRegex = /^(?<file>[^\(\n]+)\((?<line>\d+),(?<column>\d+)\): (?<severity>error|warning) (?<code>TS\d+): (?<message>.*)$/;

export function parseTypeScript(stdout, stderr) {
  const text = `${stdout ?? ''}\n${stderr ?? ''}`.replace(/\r\n/g, '\n');
  const issues = [];
  let current = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line) {
      if (current) {
        issues.push(current);
        current = null;
      }
      continue;
    }

    const match = tsDiagnosticRegex.exec(line);
    if (match) {
      if (current) issues.push(current);
      const { file, line: ln, column, severity, code, message } = match.groups;
      current = {
        file: path.normalize(file),
        line: Number(ln),
        column: Number(column),
        severity,
        code,
        message: message.trim(),
        source: 'tsc',
      };
      continue;
    }

    if (current) {
      current.message = `${current.message}\n${line.trim()}`;
    }
  }

  if (current) issues.push(current);

  const summaryMatch = /Found\s+(\d+)\s+error/.exec(text);
  const summary = summaryMatch ? { errors: Number(summaryMatch[1]) } : null;

  return { issues, summary, raw: text };
}

export function parseEslint(jsonText) {
  let report;
  try {
    report = JSON.parse(jsonText);
  } catch (error) {
    return { issues: [], summary: null, error: error instanceof Error ? error.message : String(error), raw: jsonText };
  }

  const issues = [];
  let errorCount = 0;
  let warningCount = 0;

  for (const fileReport of report) {
    for (const message of fileReport.messages) {
      const severity = message.severity === 2 ? 'error' : 'warning';
      if (severity === 'error') errorCount += 1; else warningCount += 1;
      issues.push({
        file: path.normalize(fileReport.filePath),
        line: message.line ?? 0,
        column: message.column ?? 0,
        severity,
        ruleId: message.ruleId ?? undefined,
        message: message.message,
        source: 'eslint',
      });
    }
  }

  return { issues, summary: { errors: errorCount, warnings: warningCount }, raw: jsonText };
}

export function parseJestReport(report) {
  if (!report) {
    return { issues: [], summary: null };
  }

  const issues = [];
  for (const suite of report.testResults ?? []) {
    for (const assertion of suite.assertionResults ?? []) {
      if (assertion.status === 'failed') {
        issues.push({
          file: path.normalize(suite.name ?? suite.testFilePath ?? ''),
          line: assertion.location?.line ?? null,
          column: assertion.location?.column ?? null,
          severity: 'error',
          title: assertion.fullName,
          message: (assertion.failureMessages || []).join('\n') || assertion.status,
          source: 'jest',
        });
      }
    }

    const suiteMessage =
      suite.failureMessage ||
      (Array.isArray(suite.failureMessages) ? suite.failureMessages.join('\n') : '') ||
      suite.message ||
      suite.testExecError?.message ||
      '';
    if (suite.status === 'failed' && suiteMessage) {
      issues.push({
        file: path.normalize(suite.name ?? suite.testFilePath ?? ''),
        line: null,
        column: null,
        severity: 'error',
        title: suite.name,
        message: suiteMessage,
        source: 'jest',
      });
    }
  }

  const summary = {
    failedTests: report.numFailedTests ?? 0,
    failedSuites: report.numFailedTestSuites ?? 0,
    runtimeErrorSuites: report.numRuntimeErrorTestSuites ?? 0,
    totalTests: report.numTotalTests ?? 0,
  };

  return { issues, summary };
}

function pushIssue(list, issue) {
  list.push({
    file: path.normalize(issue.file ?? ''),
    line: issue.line ?? 0,
    column: issue.column ?? 0,
    severity: issue.severity ?? 'warning',
    message: issue.message ?? 'knip issue',
    source: 'knip',
  });
}

function normalizeLocation(entry) {
  return {
    line: typeof entry?.line === 'number' ? entry.line : 0,
    column: typeof entry?.col === 'number' ? entry.col : typeof entry?.column === 'number' ? entry.column : 0,
  };
}

function describeEntry(prefix, entry) {
  if (!entry) return prefix;
  if (typeof entry === 'string') return `${prefix}: ${entry}`;
  if (entry && typeof entry.name === 'string') return `${prefix}: ${entry.name}`;
  return `${prefix}: ${JSON.stringify(entry)}`;
}

export function parseKnip(stdout) {
  const text = stdout ?? '';
  const trimmed = text.trim();
  const issues = [];

  if (!trimmed) return { issues, summary: { issueCount: 0 }, raw: text };

  if (trimmed.startsWith('{')) {
    try {
      const data = JSON.parse(trimmed);
      if (Array.isArray(data.files)) {
        for (const file of data.files) {
          pushIssue(issues, {
            file,
            line: 0,
            column: 0,
            severity: 'warning',
            message: 'Unused file',
          });
        }
      }

      if (Array.isArray(data.issues)) {
        for (const entry of data.issues) {
          const file = entry.file ?? '';

          const categories = [
            ['dependencies', 'Unused dependency'],
            ['devDependencies', 'Unused devDependency'],
            ['optionalPeerDependencies', 'Unused optional peer dependency'],
            ['unlisted', 'Unlisted dependency'],
            ['binaries', 'Unused binary'],
            ['unresolved', 'Unresolved import'],
            ['exports', 'Unused export'],
            ['types', 'Unused type export'],
          ];

          for (const [key, label] of categories) {
            const values = entry[key];
            if (!values) continue;
            const list = Array.isArray(values) ? values : [];
            for (const value of list) {
              const { line, column } = normalizeLocation(value);
              pushIssue(issues, {
                file,
                line,
                column,
                severity: 'warning',
                message: describeEntry(label, value),
              });
            }
          }

          if (entry.enumMembers && typeof entry.enumMembers === 'object') {
            for (const [enumName, members] of Object.entries(entry.enumMembers)) {
              if (!Array.isArray(members)) continue;
              for (const member of members) {
                const { line, column } = normalizeLocation(member);
                pushIssue(issues, {
                  file,
                  line,
                  column,
                  severity: 'warning',
                  message: describeEntry(`Unused enum member ${enumName}`, member),
                });
              }
            }
          }
        }
      }

      return {
        issues,
        summary: { issueCount: issues.length },
        raw: text,
      };
    } catch (error) {
      return {
        issues,
        summary: null,
        raw: text,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let currentFile = null;

  for (const line of lines) {
    if (line.endsWith(':')) {
      currentFile = path.normalize(line.slice(0, -1));
      continue;
    }
    if (!currentFile) continue;
    if (/^\d+:\d+/.test(line)) {
      const [location, ...rest] = line.split('-');
      const [lineNo, columnNo] = location.split(':');
      issues.push({
        file: currentFile,
        line: Number(lineNo),
        column: Number(columnNo),
        severity: 'warning',
        message: rest.join('-').trim(),
        source: 'knip',
      });
    }
  }

  return { issues, summary: { issueCount: issues.length }, raw: text };
}
