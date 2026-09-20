import { describe, expect, it, vi } from "vitest";
import {
  CloudSetupDependencies,
  CloudSetupIO,
  redactRemote,
  runCloudSetupWizard,
} from "../src/cloud-setup.js";
import { SyncStatus } from "../src/sync.js";
import { WorkspaceContext } from "../src/workspaces.js";

function status(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    enabled: false,
    connected: false,
    branch: "main",
    state: "off",
    pendingChanges: 0,
    ahead: 0,
    behind: 0,
    conflicts: [],
    ...overrides,
  };
}

function workspace(name: string, active = false): WorkspaceContext {
  return { name, path: `/vaults/${name}`, active, source: "registry" };
}

function ioWithAnswers(answers: string[]): { io: CloudSetupIO; output: string[] } {
  const output: string[] = [];
  return {
    io: {
      question: async (prompt) => {
        output.push(prompt);
        const answer = answers.shift();
        if (answer === undefined) throw new Error(`Missing test answer for: ${prompt}`);
        return answer;
      },
      print: (message = "") => output.push(message),
    },
    output,
  };
}

function dependencies(overrides: Partial<CloudSetupDependencies> = {}): CloudSetupDependencies {
  const personal = workspace("personal", true);
  return {
    resolveWorkspace: () => personal,
    listWorkspaces: () => [personal],
    isInitialized: () => true,
    initialize: vi.fn(),
    getStatus: () => status(),
    configure: (_vault, options) =>
      status({
        enabled: options.enabled,
        connected: true,
        remote: options.remote,
        branch: options.branch,
        state: options.enabled ? "idle" : "off",
      }),
    sync: () => ({
      status: status({ enabled: true, connected: true, state: "idle", remote: "remote.git" }),
      committed: true,
      pulled: 0,
      pushed: true,
    }),
    ...overrides,
  };
}

describe("Cloud Sync setup wizard", () => {
  it("guides workspace selection, configuration, and the first sync", async () => {
    const personal = workspace("personal", true);
    const work = workspace("work");
    const configure = vi.fn((_vault: string, options: { remote: string; branch: string; enabled: boolean }) =>
      status({
        enabled: options.enabled,
        connected: true,
        remote: options.remote,
        branch: options.branch,
        state: "idle",
      })
    );
    const sync = vi.fn(() => ({
      status: status({ enabled: true, connected: true, remote: "git@github.com:me/work.git", branch: "docs", state: "idle" }),
      committed: true,
      pulled: 0,
      pushed: true,
    }));
    const { io, output } = ioWithAnswers([
      "2",
      "git@github.com:me/work.git",
      "docs",
      "",
      "",
      "",
    ]);

    const result = await runCloudSetupWizard(
      io,
      {},
      dependencies({
        resolveWorkspace: () => personal,
        listWorkspaces: () => [personal, work],
        configure,
        sync,
      })
    );

    expect(result.cancelled).toBe(false);
    expect(result.workspace?.name).toBe("work");
    expect(configure).toHaveBeenCalledWith("/vaults/work", {
      remote: "git@github.com:me/work.git",
      branch: "docs",
      enabled: true,
    });
    expect(sync).toHaveBeenCalledWith("/vaults/work");
    expect(output.join("\n")).toContain("[5/5] 确认配置");
  });

  it("initializes an uninitialized vault after confirmation", async () => {
    const initialize = vi.fn();
    const { io } = ioWithAnswers([
      "", // active workspace
      "", // initialize
      "git@example.com:docky.git",
      "", // main
      "n", // leave sync off
      "", // apply
    ]);

    const result = await runCloudSetupWizard(
      io,
      {},
      dependencies({ isInitialized: () => false, initialize })
    );

    expect(initialize).toHaveBeenCalledWith("/vaults/personal");
    expect(result.initialized).toBe(true);
    expect(result.status?.enabled).toBe(false);
  });

  it("does not write configuration when the review is cancelled", async () => {
    const configure = vi.fn();
    const { io } = ioWithAnswers([
      "",
      "git@example.com:docky.git",
      "",
      "",
      "n",
    ]);

    const result = await runCloudSetupWizard(io, {}, dependencies({ configure }));

    expect(result.cancelled).toBe(true);
    expect(configure).not.toHaveBeenCalled();
  });

  it("redacts credentials when displaying an HTTPS remote", () => {
    expect(redactRemote("https://alice:secret@example.com/private.git")).toBe(
      "https://***:***@example.com/private.git"
    );
  });
});
