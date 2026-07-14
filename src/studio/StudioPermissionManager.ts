import { normalizePath } from "obsidian";
import type { StudioCapabilityGrant, StudioPermissionPolicyV1 } from "./types";
import { isBlanketCliCommandPattern, nowIso, randomId } from "./utils";

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const replaced = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${replaced}$`);
}

export class StudioPermissionManager {
  constructor(private policy: StudioPermissionPolicyV1) {}

  public getPolicy(): StudioPermissionPolicyV1 {
    return this.policy;
  }

  public setPolicy(next: StudioPermissionPolicyV1): void {
    this.policy = next;
  }

  public addGrant(grant: Omit<StudioCapabilityGrant, "id" | "grantedAt">): StudioCapabilityGrant {
    const nextGrant: StudioCapabilityGrant = {
      ...grant,
      id: randomId("grant"),
      grantedAt: nowIso(),
    };

    this.policy = {
      ...this.policy,
      updatedAt: nowIso(),
      grants: [...this.policy.grants, nextGrant],
    };

    return nextGrant;
  }

  private grantsFor(capability: StudioCapabilityGrant["capability"]): StudioCapabilityGrant[] {
    return this.policy.grants.filter((grant) => grant.capability === capability);
  }

  public assertFilesystemPath(path: string): void {
    const normalized = normalizePath(String(path || "").trim());
    if (!normalized) {
      throw new Error("Filesystem permission denied: path is empty.");
    }

    const grants = this.grantsFor("filesystem");
    for (const grant of grants) {
      const allowedPaths = (grant.scope.allowedPaths || []).map((entry) => normalizePath(entry));
      for (const allowedPath of allowedPaths) {
        if (allowedPath === "*" || allowedPath === "/") {
          return;
        }
        if (normalized === allowedPath || normalized.startsWith(`${allowedPath}/`)) {
          return;
        }
      }
    }

    throw new Error(`Filesystem permission denied for path "${normalized}".`);
  }

  public assertCliCommand(command: string): void {
    const trimmed = String(command || "").trim();
    if (!trimmed) {
      throw new Error("CLI permission denied: command is empty.");
    }

    const grants = this.grantsFor("cli");
    for (const grant of grants) {
      const patterns = grant.scope.allowedCommandPatterns || [];
      for (const pattern of patterns) {
        if (!pattern.trim()) continue;
        // SEC-03 defense-in-depth: a bare "*" matches every command. Even if a
        // policy bypassed parse-time stripping, never honor it as an allow-all.
        if (isBlanketCliCommandPattern(pattern)) continue;
        if (wildcardToRegExp(pattern.trim()).test(trimmed)) {
          return;
        }
      }
    }

    throw new Error(`CLI permission denied for command "${trimmed}".`);
  }
}
