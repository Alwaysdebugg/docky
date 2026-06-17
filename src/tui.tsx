/**
 * docky TUI — a Claude-Code-style REPL built with Ink.
 *
 * Single command input at the bottom; results stream above it. Type `/` to see
 * the full command menu (filtered as you type); Tab completes. No panes.
 */
import React, { useState } from "react";
import { Box, Static, Text, render, useApp, useInput, useStdin } from "ink";
import TextInput from "ink-text-input";
import { OutLine, executeCommand, suggest } from "./commands.js";
import * as core from "./core.js";
import { DocInfo, DockyError } from "./types.js";
import { openExternally, renderMarkdown, spawnPager } from "./pager.js";

function colorOf(level: OutLine["level"]): string | undefined {
  switch (level) {
    case "in":
      return "gray";
    case "info":
      return "cyan";
    case "err":
      return "red";
    case "ok":
      return "green";
    default:
      return undefined;
  }
}

type HistItem = OutLine & { key: number; banner?: boolean };

function welcomeItems(): Array<OutLine & { banner?: boolean }> {
  return [{ text: "", level: "info", banner: true }];
}

// oh-my-logo style ASCII wordmark (ANSI Shadow font) for "DOCKY".
const LOGO = [
  "██████╗  ██████╗  ██████╗██╗  ██╗██╗   ██╗",
  "██╔══██╗██╔═══██╗██╔════╝██║ ██╔╝╚██╗ ██╔╝",
  "██║  ██║██║   ██║██║     █████╔╝  ╚████╔╝ ",
  "██║  ██║██║   ██║██║     ██╔═██╗   ╚██╔╝  ",
  "██████╔╝╚██████╔╝╚██████╗██║  ██╗   ██║   ",
  "╚═════╝  ╚═════╝  ╚═════╝╚═╝  ╚═╝   ╚═╝   ",
];
// Top-to-bottom gradient (cyan → purple), like oh-my-logo.
const GRADIENT = ["#00d7ff", "#27b6e6", "#5f93f0", "#8f6def", "#b35cef", "#d75fff"];

/** oh-my-logo style welcome wordmark. */
function Banner() {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {LOGO.map((l, i) => (
        <Text key={i} bold color={GRADIENT[i]}>
          {l}
        </Text>
      ))}
      <Text dimColor>Docky · 文档管理 · 输入 / 看命令 · /help 帮助 · /exit 退出</Text>
    </Box>
  );
}

export interface AppProps {
  vault: string;
  initialProject: string | null;
}

let LINE_KEY = 0;

export function App({ vault, initialProject }: AppProps) {
  const { exit } = useApp();
  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  const [project, setProject] = useState<string | null>(initialProject);
  const [history, setHistory] = useState<HistItem[]>(
    welcomeItems().map((l) => ({ ...l, key: LINE_KEY++ }))
  );
  const [value, setValue] = useState("");
  const [selected, setSelected] = useState(0);
  const [, setRedraw] = useState(0);

  // Interactive selectors (entered via /list and /projects).
  const [mode, setMode] = useState<"repl" | "browse" | "projects">("repl");
  const [browseDocs, setBrowseDocs] = useState<DocInfo[]>([]);
  const [browseSel, setBrowseSel] = useState(0);
  const [browseTitle, setBrowseTitle] = useState("");
  const [projNames, setProjNames] = useState<string[]>([]);
  const [projSel, setProjSel] = useState(0);

  const suggestions = suggest(value);
  const menuWidth = Math.min((process.stdout.columns || 80) - 4, 76);
  const sel = suggestions.length > 0 ? Math.min(selected, suggestions.length - 1) : 0;

  function append(lines: OutLine[]) {
    setHistory((h) => [...h, ...lines.map((l) => ({ ...l, key: LINE_KEY++ }))]);
  }

  /** Render a doc and view it in the same-terminal pager, suspending Ink. */
  function openInPager(rel: string): void {
    if (!project) {
      append([{ text: "› /open " + rel, level: "in" }, { text: "当前没有选中项目,用 /use 切换。", level: "err" }]);
      return;
    }
    let content: string;
    try {
      content = core.readDoc(vault, project, rel);
    } catch (e) {
      const msg = e instanceof DockyError ? e.message : `错误: ${(e as Error).message}`;
      append([{ text: "› /open " + rel, level: "in" }, { text: msg, level: "err" }]);
      return;
    }
    const rendered = renderMarkdown(content);
    if (!process.stdout.isTTY || !isRawModeSupported) {
      append([{ text: "› /open " + rel, level: "in" }, ...rendered.split("\n").map((t) => ({ text: t, level: "out" as const }))]);
      return;
    }
    append([{ text: `› /open ${rel}（在分页器中查看,按 q 返回）`, level: "in" }]);
    try {
      setRawMode(false);
      stdin.pause();
      spawnPager(rendered);
    } finally {
      stdin.resume();
      setRawMode(true);
      setRedraw((r) => r + 1); // force Ink to repaint after the pager
    }
  }

  /** Enter the interactive, hierarchical document browser. */
  function enterBrowse(type?: string): void {
    if (!project) {
      append([{ text: "› /list", level: "in" }, { text: "当前没有选中项目,用 /use 切换。", level: "err" }]);
      return;
    }
    let docs: DocInfo[];
    try {
      docs = core.listDocs(vault, project, type);
    } catch (e) {
      const msg = e instanceof DockyError ? e.message : `错误: ${(e as Error).message}`;
      append([{ text: "› /list " + (type ?? ""), level: "in" }, { text: msg, level: "err" }]);
      return;
    }
    if (docs.length === 0) {
      append([{ text: "› /list " + (type ?? ""), level: "in" }, { text: "(无文档)", level: "info" }]);
      return;
    }
    setBrowseDocs(docs);
    setBrowseSel(0);
    setBrowseTitle(`${project}${type ? " · " + type : ""}  (${docs.length} 篇)`);
    setMode("browse");
  }

  /** Enter the interactive project selector. */
  function enterProjects(): void {
    const names = Object.keys(core.listProjects(vault));
    if (names.length === 0) {
      append([{ text: "› /projects", level: "in" }, { text: "还没有注册任何项目,用 /register 注册。", level: "info" }]);
      return;
    }
    setProjNames(names);
    setProjSel(Math.max(0, project ? names.indexOf(project) : 0));
    setMode("projects");
  }

  function runRaw(raw: string) {
    const body = raw.trim().replace(/^\//, "");
    const [c, ...a] = body.split(/\s+/);
    if (c.toLowerCase() === "open" && a[0]) {
      openInPager(a[0]);
      setValue("");
      return;
    }
    if (c.toLowerCase() === "list") {
      enterBrowse(a[0]);
      setValue("");
      return;
    }
    if (c.toLowerCase() === "projects") {
      enterProjects();
      setValue("");
      return;
    }
    const res = executeCommand(vault, project, raw);
    if (res.clear) {
      setHistory([]);
      setValue("");
      return;
    }
    append(res.output);
    if (res.project !== undefined) setProject(res.project);
    setValue("");
    if (res.exit) exit();
  }

  function onSubmit(raw: string) {
    if (!raw.trim()) return;
    // If the command menu is open, Enter acts on the highlighted command.
    if (suggestions.length > 0) {
      const chosen = suggestions[sel];
      if (chosen.args) {
        // Needs arguments: complete into the input and wait for them.
        setValue(`/${chosen.name} `);
        setSelected(0);
        return;
      }
      runRaw(`/${chosen.name}`);
      return;
    }
    runRaw(raw);
  }

  useInput((input, key) => {
    // Document browser navigation.
    if (mode === "browse") {
      if (key.upArrow) setBrowseSel((s) => Math.max(0, s - 1));
      else if (key.downArrow) setBrowseSel((s) => Math.min(browseDocs.length - 1, s + 1));
      else if (key.return) {
        const d = browseDocs[browseSel];
        if (d) {
          openExternally(d.path);
          append([{ text: `已用默认应用打开 ${d.rel}`, level: "ok" }]);
        }
      } else if (key.escape || input === "q") {
        setMode("repl");
      }
      return;
    }
    // Project selector navigation.
    if (mode === "projects") {
      if (key.upArrow) setProjSel((s) => Math.max(0, s - 1));
      else if (key.downArrow) setProjSel((s) => Math.min(projNames.length - 1, s + 1));
      else if (key.return) {
        const name = projNames[projSel];
        if (name) {
          setProject(name);
          append([{ text: `已切换到项目 ${name}`, level: "ok" }]);
        }
        setMode("repl");
      } else if (key.escape || input === "q") {
        setMode("repl");
      }
      return;
    }
    // Command menu navigation.
    if (suggestions.length === 0) return;
    if (key.downArrow) setSelected((s) => Math.min(s + 1, suggestions.length - 1));
    else if (key.upArrow) setSelected((s) => Math.max(s - 1, 0));
    else if (key.tab) {
      // Tab completes the highlighted command (then awaits args, if any).
      setValue(`/${suggestions[sel].name} `);
      setSelected(0);
    }
  });

  // Build hierarchical rows (type headers + indented file names) for browse mode.
  function browseRows(): React.ReactNode[] {
    const rows: React.ReactNode[] = [];
    let lastType = "";
    browseDocs.forEach((d, i) => {
      if (d.type !== lastType) {
        rows.push(
          <Text key={"h-" + d.type} color="yellow" bold>
            {d.type}/
          </Text>
        );
        lastType = d.type;
      }
      const active = i === browseSel;
      rows.push(
        <Text key={d.rel} color={active ? "cyanBright" : undefined} inverse={active}>
          {active ? "  ▸ " : "    "}
          {d.name}
        </Text>
      );
    });
    return rows;
  }

  // Rows for the project selector (name + dim path).
  function projectRows(): React.ReactNode[] {
    const meta = core.listProjects(vault);
    const width = Math.max(...projNames.map((n) => n.length), 8) + 2;
    return projNames.map((name, i) => {
      const active = i === projSel;
      const paths = (meta[name]?.paths ?? []).join(", ");
      return (
        <Box key={name}>
          <Text color={active ? "cyanBright" : "green"} inverse={active}>
            {active ? "▸ " : "  "}
            {name.padEnd(width)}
          </Text>
          <Text dimColor>{paths}</Text>
        </Box>
      );
    });
  }

  return (
    <Box flexDirection="column">
      <Static items={history}>
        {(l) =>
          l.banner ? (
            <Banner key={l.key} />
          ) : (
            <Text key={l.key} color={colorOf(l.level)}>
              {l.text || " "}
            </Text>
          )
        }
      </Static>

      {mode === "browse" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">{browseTitle}</Text>
          {browseRows()}
          <Box marginTop={1}>
            <Text dimColor>↑/↓ 选择 · Enter 用默认应用打开 · Esc/q 返回</Text>
          </Box>
        </Box>
      ) : mode === "projects" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">已注册项目 ({projNames.length})</Text>
          {projectRows()}
          <Box marginTop={1}>
            <Text dimColor>↑/↓ 选择 · Enter 切换到该项目 · Esc/q 返回</Text>
          </Box>
        </Box>
      ) : (
        <>
          <Box marginTop={1}>
            <Text color="green">{project ? `[${project}] ` : "[no project] "}</Text>
            <Text color="cyan">› </Text>
            <TextInput
              value={value}
              onChange={(v) => {
                setValue(v.replace(/\t/g, ""));
                setSelected(0);
              }}
              onSubmit={onSubmit}
              placeholder="输入命令,/ 看菜单"
            />
          </Box>

          {suggestions.length > 0 && (
            <Box flexDirection="column" marginLeft={2}>
              {suggestions.map((s, i) => (
                <Box key={s.name} width={menuWidth} justifyContent="space-between">
                  <Text color={i === sel ? "cyanBright" : "gray"}>
                    {i === sel ? "▸ " : "  "}
                    {s.usage}
                  </Text>
                  <Text color={i === sel ? "cyan" : "gray"} dimColor={i !== sel}>
                    {s.desc}
                  </Text>
                </Box>
              ))}
            </Box>
          )}

          <Box marginTop={suggestions.length > 0 ? 0 : 1}>
            <Text dimColor>↑/↓ 选择 · Tab 补全 · Enter 执行 · /exit 退出</Text>
          </Box>
        </>
      )}
    </Box>
  );
}

export function runTui(vault: string, initialProject: string | null): void {
  render(<App vault={vault} initialProject={initialProject} />);
}

/** Resolve the project to start on (from cwd), tolerating "not registered". */
export function detectProject(vault: string): string | null {
  try {
    return core.resolveProject(vault, process.cwd()).project;
  } catch {
    return null;
  }
}
