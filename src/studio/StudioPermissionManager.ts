import { normalizePath } from "obsidian";
import type { StudioCapabilityGrant, StudioPermissionPolicyV1 } from "./types";
import { nowIso, randomId } from "./utils";

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const replaced = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${replaced}$`);
}

function hostMatchesDomain(hostname: string, domain: string): boolean {
  const normalizedHost = String(hostname || "").toLowerCase();
  const normalizedDomain = String(domain || "").toLowerCase().replace(/^\.+/, "");
  if (!normalizedHost || !normalizedDomain) return false;
  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
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
        if (wildcardToRegExp(pattern.trim()).test(trimmed)) {
          return;
        }
      }
    }

    throw new Error(`CLI permission denied for command "${trimmed}".`);
  }

  public assertNetworkUrl(url: string): void {
    const raw = String(url || "").trim();
    if (!raw) {
      throw new Error("Network permission denied: URL is empty.");
    }

    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`Network permission denied: invalid URL "${raw}".`);
    }

    if (parsed.protocol !== "https:") {
      throw new Error(`Network permission denied: only HTTPS URLs are allowed ("${raw}").`);
    }

    const hostname = parsed.hostname.toLowerCase();
    const grants = this.grantsFor("network");
    for (const grant of grants) {
      const domains = grant.scope.allowedDomains || [];
      if (domains.some((domain) => domain.trim() === "*")) {
        return;
      }
      if (domains.some((domain) => hostMatchesDomain(hostname, domain))) {
        return;
      }
    }

    throw new Error(`Network permission denied for domain "${hostname}".`);
  }
}
