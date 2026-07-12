import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as ts from "typescript";

const root = path.resolve(__dirname, "../../../..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
const exactTypeFiles = [
  "src/main.ts",
  "src/services/managed/ManagedCapabilityClient.ts",
  "src/services/managed/ManagedCapabilityClientFactory.ts",
  "src/services/managed/ManagedTypes.ts",
  "src/views/chatview/uiSetup.ts",
  "src/views/chatview/InputHandler.ts",
  "src/views/chatview/ChatView.ts",
  "src/views/chatview/messageHandling.ts",
  "src/views/chatview/transcript/ChatTranscript.ts",
  "src/views/chatview/transcript/ChatTranscriptTypes.ts",
  "src/views/chatview/turn/ChatTurn.ts",
  "src/views/chatview/turn/ChatTurnEffects.ts",
] as const;

function repoProgram(): { program: ts.Program; checker: ts.TypeChecker } {
  const configPath = path.join(root, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, undefined, configPath);
  const consumerTests = [path.join(root, "src/views/chatview/__tests__/input-handler-tool-loop.test.ts")];
  const program = ts.createProgram({ rootNames: [...parsed.fileNames, ...consumerTests], options: parsed.options });
  return { program, checker: program.getTypeChecker() };
}

const typedRepo = repoProgram();

function source(relative: string): ts.SourceFile {
  const resolved = path.normalize(path.join(root, relative));
  const found = typedRepo.program.getSourceFile(resolved)
    ?? typedRepo.program.getSourceFiles().find((candidate) => path.normalize(candidate.fileName) === resolved);
  if (!found) throw new Error(`TypeScript Program did not include ${relative}`);
  return found;
}

function constructors(relative: string): ts.NewExpression[] {
  const file = source(relative);
  const found: ts.NewExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && node.expression.getText(file) === "InputHandler") found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function hasRequiredProperty(node: ts.NewExpression, name: string): boolean {
  const argument = node.arguments?.[0];
  return !!argument && ts.isObjectLiteralExpression(argument)
    && argument.properties.some((property) =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
      && property.name.getText().replace(/["']/g, "") === name
    );
}

function symbolName(type: ts.Type): string | undefined {
  return type.aliasSymbol?.getName() ?? type.getSymbol()?.getName();
}

function assertTypeHasNoAny(
  checker: ts.TypeChecker,
  type: ts.Type,
  location: ts.Node,
  label: string,
  seen = new Set<ts.Type>(),
  depth = 0,
): number {
  if (type.flags & ts.TypeFlags.Any) throw new Error(`${label} resolves to any at ${location.getSourceFile().fileName}`);
  if (seen.has(type) || depth > 8) return 1;
  seen.add(type);
  let traversed = 1;
  if (type.isUnionOrIntersection()) {
    for (const member of type.types) traversed += assertTypeHasNoAny(checker, member, location, label, seen, depth + 1);
  }
  const reference = type as ts.TypeReference;
  for (const argument of checker.getTypeArguments(reference)) {
    traversed += assertTypeHasNoAny(checker, argument, location, label, seen, depth + 1);
  }
  for (const signature of [...type.getCallSignatures(), ...type.getConstructSignatures()]) {
    traversed += assertTypeHasNoAny(checker, signature.getReturnType(), location, label, seen, depth + 1);
    for (const parameter of signature.getParameters()) {
      const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0] ?? location;
      traversed += assertTypeHasNoAny(checker, checker.getTypeOfSymbolAtLocation(parameter, declaration), declaration, label, seen, depth + 1);
    }
  }
  for (const property of type.getProperties()) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (!declaration) continue;
    const relative = path.relative(root, declaration.getSourceFile().fileName).replace(/\\/g, "/");
    if (!exactTypeFiles.includes(relative as (typeof exactTypeFiles)[number])) continue;
    traversed += assertTypeHasNoAny(checker, checker.getTypeOfSymbolAtLocation(property, declaration), declaration, label, seen, depth + 1);
  }
  return traversed;
}

function namedDeclarations(file: ts.SourceFile, names: ReadonlySet<string>): ts.NamedDeclaration[] {
  const declarations: ts.NamedDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if ("name" in node && !ts.isImportSpecifier(node) && !ts.isImportClause(node) && !ts.isNamespaceImport(node)) {
      const named = node as ts.NamedDeclaration;
      if (named.name && ts.isIdentifier(named.name) && names.has(named.name.text)) declarations.push(named);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return declarations;
}

describe("managed chat ownership structure", () => {
  it("builds the repository TypeScript Program and type-checks the ownership flow without any escapes", () => {
    expect(typedRepo.program.getCompilerOptions().noImplicitAny).toBe(true);
    expect(typedRepo.checker).toBeDefined();
    for (const relative of exactTypeFiles) expect(source(relative)).toBeDefined();

    const names = new Set([
      "managedChatAdmission", "acceptedOperation", "lease", "pendingSubmissionIntent",
      "commitInput", "commitAcceptedUserMessage", "claimAcceptedUserCommit",
      "AcceptedChatOperation", "ManagedAllowedLease", "ManagedChatAdmissionPort",
      "PendingSubmissionIntent", "AcceptedUserCommitInput", "AcceptedUserCommitResult",
    ]);
    let declarations = 0;
    let traversedTypes = 0;
    for (const relative of exactTypeFiles) {
      for (const declaration of namedDeclarations(source(relative), names)) {
        declarations += 1;
        const type = typedRepo.checker.getTypeAtLocation(declaration);
        traversedTypes += assertTypeHasNoAny(typedRepo.checker, type, declaration, declaration.name?.getText() ?? relative);
      }
    }
    expect(declarations).toBeGreaterThanOrEqual(20);
    expect(traversedTypes).toBeGreaterThan(declarations);
  });

  it("mechanically rejects an inferred-any ownership fixture", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "managed-chat-type-guard-"));
    const fixture = path.join(directory, "fixture.ts");
    fs.writeFileSync(fixture, "declare function untyped(): any; const managedChatAdmission = untyped();\n");
    const program = ts.createProgram({ rootNames: [fixture], options: { strict: true, noEmit: true } });
    const checker = program.getTypeChecker();
    const file = program.getSourceFile(fixture);
    if (!file) throw new Error("Missing negative fixture");
    const declaration = namedDeclarations(file, new Set(["managedChatAdmission"]))[0];
    expect(() => assertTypeHasNoAny(checker, checker.getTypeAtLocation(declaration), declaration, "managedChatAdmission")).toThrow(/resolves to any/);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("asserts exact nonoptional DI symbol identities", () => {
    const input = source("src/views/chatview/InputHandler.ts");
    const options = namedDeclarations(input, new Set(["InputHandlerOptions"]))[0];
    const optionsType = typedRepo.checker.getTypeAtLocation(options);
    for (const [propertyName, expectedType] of [
      ["managedChatAdmission", "ManagedChatAdmissionPort"],
      ["commitAcceptedUserMessage", undefined],
      ["claimAcceptedUserCommit", undefined],
    ] as const) {
      const property = optionsType.getProperty(propertyName);
      expect(property).toBeDefined();
      expect(property?.flags & ts.SymbolFlags.Optional).toBe(0);
      const declaration = property?.valueDeclaration ?? property?.declarations?.[0];
      if (!property || !declaration) throw new Error(`Missing ${propertyName}`);
      const propertyType = typedRepo.checker.getTypeOfSymbolAtLocation(property, declaration);
      expect(propertyType.flags & ts.TypeFlags.Any).toBe(0);
      if (expectedType) expect(symbolName(propertyType)).toBe(expectedType);
    }

    const managedTypes = source("src/services/managed/ManagedTypes.ts");
    const accepted = namedDeclarations(managedTypes, new Set(["AcceptedChatOperation"]))[0];
    const acceptedType = typedRepo.checker.getTypeAtLocation(accepted);
    const lease = acceptedType.getProperty("lease");
    const leaseDeclaration = lease?.valueDeclaration ?? lease?.declarations?.[0];
    if (!lease || !leaseDeclaration) throw new Error("AcceptedChatOperation.lease is missing");
    expect(symbolName(typedRepo.checker.getTypeOfSymbolAtLocation(lease, leaseDeclaration))).toBe("ManagedAllowedLease");

    const view = source("src/views/chatview/ChatView.ts");
    const accessor = namedDeclarations(view, new Set(["getManagedChatAdmission"]))[0];
    expect(symbolName(typedRepo.checker.getTypeAtLocation(accessor))).toBe("getManagedChatAdmission");
    const signature = typedRepo.checker.getSignatureFromDeclaration(accessor as ts.MethodDeclaration);
    expect(symbolName(signature?.getReturnType() as ts.Type)).toBe("ManagedChatAdmissionPort");
  });

  it("inventories exactly ten mandatory-DI constructors", () => {
    const files: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
        const relative = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(relative);
        else if (
          entry.isFile() && entry.name.endsWith(".ts")
          && relative !== "src/views/chatview/__tests__/input-handler-managed-chat.test.ts"
          && read(relative).includes("new InputHandler(")
        ) files.push(relative);
      }
    };
    walk("src/views/chatview");
    const inventory = files.flatMap((file) => constructors(file).map((node) => ({ file, node })));
    const production = inventory.filter(({ file }) => file === "src/views/chatview/uiSetup.ts").map(({ node }) => node);
    const tests = inventory.filter(({ file }) => file === "src/views/chatview/__tests__/input-handler-tool-loop.test.ts").map(({ node }) => node);
    expect(inventory).toHaveLength(10);
    expect(production).toHaveLength(1);
    expect(tests).toHaveLength(9);
    for (const node of [...production, ...tests]) {
      expect(hasRequiredProperty(node, "managedChatAdmission")).toBe(true);
      expect(hasRequiredProperty(node, "commitAcceptedUserMessage")).toBe(true);
      expect(hasRequiredProperty(node, "claimAcceptedUserCommit")).toBe(true);
    }
  });

  it("keeps complementary source and call guards", () => {
    const main = read("src/main.ts");
    const view = read("src/views/chatview/ChatView.ts");
    const setup = read("src/views/chatview/uiSetup.ts");
    const input = read("src/views/chatview/InputHandler.ts");
    const chatSources = [view, setup, input, read("src/views/chatview/messageHandling.ts")].join("\n");
    expect(main).toContain("ManagedCapabilityClientFactory.create");
    expect(view).toContain("return this.plugin.getManagedCapabilityClient()");
    expect(setup).toContain("managedChatAdmission: chatView.getManagedChatAdmission()");
    expect(input).toContain("managedChatAdmission: ManagedChatAdmissionPort");
    expect(input).not.toContain("managedChatAdmission?:");
    expect(chatSources).not.toMatch(/new (HostedTransportAdapter|ManagedAdmission|ManagedCapabilityClient)\b/);
    expect(chatSources).not.toContain("NODE_ENV");
    expect(chatSources).not.toContain("acquireLease(");
    expect(input).not.toContain("commitUser:");
    expect(read("src/views/chatview/turn/ChatTurnTypes.ts")).not.toMatch(/PERSIST_USER|committing_user|USER_COMMITTED/);
    const client = read("src/services/managed/ManagedCapabilityClient.ts");
    const factory = read("src/services/managed/ManagedCapabilityClientFactory.ts");
    expect(client.match(/admission\.acquireLease\(/g)).toHaveLength(1);
    expect(factory.match(/new HostedTransportAdapter\(/g)).toHaveLength(1);
    expect(factory.match(/new ManagedAdmission\(/g)).toHaveLength(1);
    expect(factory.match(/new ManagedCapabilityClient\(/g)).toHaveLength(1);
    expect(view).not.toMatch(/pendingResendProjection|projectResendSnapshot|commitResendBranch|retryPendingResend/);
    expect(read("src/views/chatview/messageHandling.ts")).not.toMatch(/commitResendBranch|retryPendingResend|branchFrom/);
  });

  it("orders candidate, admission, commit, ownership claim, operation, then lifecycle", () => {
    const text = read("src/views/chatview/InputHandler.ts");
    const ordered = [
      "const candidateMessageId = this.generateMessageId()",
      "this.managedChatAdmission.acquireChatTurnLease()",
      "this.commitAcceptedUserMessage(commitInput)",
      "this.claimAcceptedUserCommit(accepted)",
      "const acceptedOperation: AcceptedChatOperation",
      "new ChatTurnLifecycleController",
    ].map((needle) => text.indexOf(needle));
    expect(ordered.every((index) => index >= 0)).toBe(true);
    expect([...ordered].sort((left, right) => left - right)).toEqual(ordered);
  });
});
