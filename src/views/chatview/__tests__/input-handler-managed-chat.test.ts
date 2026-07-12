import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const root = path.resolve(__dirname, "../../../..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

function constructors(relative: string): ts.NewExpression[] {
  const source = ts.createSourceFile(relative, read(relative), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: ts.NewExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && node.expression.getText(source) === "InputHandler") found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
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

describe("managed chat ownership structure", () => {
  it("inventories exactly ten mandatory-DI constructors", () => {
    const files: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
        const relative = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(relative);
        else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(relative);
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

  it("proves the production singleton chain and forbids ownership bypasses", () => {
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
    expect(setup).not.toMatch(/managedChatAdmission\?/);
    expect(view).not.toMatch(/pendingResendProjection|projectResendSnapshot|commitResendBranch|retryPendingResend/);
    expect(read("src/views/chatview/messageHandling.ts")).not.toMatch(/commitResendBranch|retryPendingResend|branchFrom/);
  });

  it("orders candidate, admission, commit, ownership claim, operation, then lifecycle", () => {
    const source = read("src/views/chatview/InputHandler.ts");
    const ordered = [
      "const candidateMessageId = this.generateMessageId()",
      "this.managedChatAdmission.acquireChatTurnLease()",
      "this.commitAcceptedUserMessage(commitInput)",
      "this.claimAcceptedUserCommit(accepted)",
      "const acceptedOperation: AcceptedChatOperation",
      "new ChatTurnLifecycleController",
    ].map((needle) => source.indexOf(needle));
    expect(ordered.every((index) => index >= 0)).toBe(true);
    expect([...ordered].sort((left, right) => left - right)).toEqual(ordered);
  });
});
