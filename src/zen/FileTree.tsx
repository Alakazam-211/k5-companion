import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { getFsReadDir, type FsDirEntry, type ServerScope } from "../api/client";
import { MiddleEllipsis } from "./MiddleEllipsis";
import { EntryIcon, FolderIcon } from "./fileIcons/EntryIcon";
import { TREE_ROW_CAP, baseName, isHeavyDir, isHiddenName, treeEntries } from "./fileTreeModel";
import { isUnderWorkspace } from "./workspacePath";

type DirState =
  | { status: "loading"; entries: FsDirEntry[] }
  | { status: "ok"; entries: FsDirEntry[] }
  | { status: "error"; entries: FsDirEntry[]; error: string };

/** Under the workspace folder (or the folder itself). The phone's jail:
 *  an owner token reads any absolute path, so the client keeps to root. */
export function inTree(path: string, root: string | null): boolean {
  return Boolean(root) && (path === root || isUnderWorkspace(path, root as string));
}

/** One lazily-read folder tree rooted at `root` on `scope`'s server (the
 *  room's). Every folder is read with hidden entries; the eye filters on
 *  the phone (no refetch). Another server is another tree, even when the
 *  root path is the same. */
export function useFileTree(scope: ServerScope, root: string | null) {
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const rootRef = useRef(root);
  rootRef.current = root;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const load = useCallback(async (dir: string) => {
    const at = rootRef.current;
    const on = scopeRef.current;
    if (!inTree(dir, at)) return;
    setDirs((d) => ({ ...d, [dir]: { status: "loading", entries: d[dir]?.entries ?? [] } }));
    let next: DirState;
    try {
      const r = await getFsReadDir(on, dir, true);
      next =
        r.ok && Array.isArray(r.data)
          ? {
              status: "ok",
              // Only children of this folder (the daemon's own paths).
              entries: r.data.filter((e) => e && typeof e.path === "string" && inTree(e.path, at)),
            }
          : { status: "error", entries: [], error: r.error || "Could not read this folder" };
    } catch (e) {
      next = { status: "error", entries: [], error: e instanceof Error ? e.message : String(e) };
    }
    if (rootRef.current !== at || scopeRef.current.id !== on.id) return;
    setDirs((d) => ({ ...d, [dir]: next }));
  }, []);

  // A different workspace (or server) is a different tree.
  useEffect(() => {
    setDirs({});
    setExpanded(new Set());
    setSelected(null);
    if (root) void load(root);
  }, [root, scope.id, load]);

  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const toggle = useCallback(
    (dir: string) => {
      setSelected(dir);
      const next = new Set(expandedRef.current);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        void load(dir);
      }
      setExpanded(next);
    },
    [load]
  );

  const expand = useCallback(
    (dir: string) => {
      setExpanded((prev) => (prev.has(dir) ? prev : new Set(prev).add(dir)));
    },
    []
  );

  /** Child names of `dir` as last read (for duplicate checks). */
  const namesIn = useCallback(
    (dir: string) => (dirs[dir]?.entries ?? []).map((e) => e.name),
    [dirs]
  );

  return { root, dirs, expanded, selected, setSelected, load, toggle, expand, namesIn };
}

export type FileTreeModel = ReturnType<typeof useFileTree>;

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform 120ms" }}
    >
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

/** A row: inset 6px in the drawer tile, rounded, 36px tall, 14px names
 *  (.k2-drawer-row; K2 Design 2026-11-20). */
const ROW_BOX = "k2-drawer-row flex items-center gap-1.5 text-left py-2 pr-2.5 min-h-[36px] select-none";
const ROW_CLASS = `${ROW_BOX} text-[14px] leading-5`;
/** The workspace folder's name over the tree: 12px/600 muted. */
const ROOT_CLASS = `${ROW_BOX} text-[12px] leading-4 font-semibold text-[var(--color-text-muted)]`;
const ROW_STYLE = { WebkitTouchCallout: "none", WebkitUserSelect: "none" } as const;
/** Each level indents this much; depth 0 starts 10px in (16px from the tile). */
export const TREE_INDENT_PX = 14;
const ROW_PAD_PX = 10;
/** A row's left padding at `depth` (inside its 6px inset). */
export function treeRowPad(depth: number): number {
  return ROW_PAD_PX + depth * TREE_INDENT_PX;
}
/** Hints (loading, errors, Empty, N more): 12px muted, on the row grid. */
const HINT_CLASS = "py-1 pr-4 text-[12px] text-[var(--color-text-muted)]";
const hintPad = (depth: number) => ({ paddingLeft: 6 + treeRowPad(depth) });

/** The workspace folder/file tree. Rows carry `data-file-*` for the
 *  drawer's hold gesture (menu / drag); taps open files and toggle folders. */
export function FileTree({
  tree,
  showHidden,
  activeIds,
  heldPath = null,
  onOpenFile,
  consumeSkipClick,
}: {
  tree: FileTreeModel;
  showHidden: boolean;
  activeIds: string[];
  /** The row held for its menu: tinted like the open file. */
  heldPath?: string | null;
  onOpenFile: (path: string) => void;
  consumeSkipClick: () => boolean;
}) {
  const { root, dirs, expanded, selected, toggle, setSelected } = tree;
  if (!root) return null;

  const renderDir = (dir: string, depth: number): ReactNode => {
    const st = dirs[dir];
    if (!st || (st.status === "loading" && st.entries.length === 0)) {
      return (
        <div className={HINT_CLASS} style={hintPad(depth)} data-testid="tree-loading">
          loading
        </div>
      );
    }
    if (st.status === "error") {
      return (
        <div className={`${HINT_CLASS} break-words`} style={hintPad(depth)} data-testid="tree-error">
          {st.error}
        </div>
      );
    }
    const rows = treeEntries(st.entries, showHidden);
    if (rows.length === 0) {
      return (
        <div className={HINT_CLASS} style={hintPad(depth)}>
          Empty
        </div>
      );
    }
    const shown = rows.slice(0, TREE_ROW_CAP);
    return (
      <>
        {shown.map((e) => {
          const open = e.isDirectory && expanded.has(e.path);
          const dim = isHiddenName(e.name) || isHeavyDir(e);
          const current = (!e.isDirectory && activeIds.includes(e.path)) || heldPath === e.path;
          const sel = e.isDirectory && selected === e.path;
          return (
            <div key={e.path} role="treeitem" aria-expanded={e.isDirectory ? open : undefined}>
              <button
                type="button"
                className={`${ROW_CLASS}${current ? " font-semibold" : ""}`}
                style={{
                  ...ROW_STYLE,
                  paddingLeft: treeRowPad(depth),
                  touchAction: "pan-y",
                  background: sel && !current ? "var(--color-row-hover)" : undefined,
                  color: dim && !current ? "var(--color-text-muted)" : "var(--color-text-primary)",
                }}
                data-current={current ? "1" : undefined}
                data-file-path={e.path}
                data-file-name={e.name}
                data-file-dir={e.isDirectory ? "1" : "0"}
                data-file-section="tree"
                data-testid={e.isDirectory ? "tree-dir" : "tree-file"}
                aria-label={e.name}
                title={e.name}
                onClick={() => {
                  if (consumeSkipClick()) return;
                  if (e.isDirectory) toggle(e.path);
                  else onOpenFile(e.path);
                }}
              >
                <span className="shrink-0 w-[10px] flex justify-center text-[var(--color-text-muted)]">
                  {e.isDirectory ? <Chevron open={open} /> : null}
                </span>
                <span className="shrink-0 flex items-center" style={{ opacity: dim ? 0.55 : undefined }}>
                  <EntryIcon name={e.name} isDirectory={e.isDirectory} open={open} />
                </span>
                <MiddleEllipsis text={e.name} className="flex-1" />
              </button>
              {open ? renderDir(e.path, depth + 1) : null}
            </div>
          );
        })}
        {rows.length > shown.length ? (
          <div className={HINT_CLASS} style={hintPad(depth)} data-testid="tree-more">
            {rows.length - shown.length} more
          </div>
        ) : null}
      </>
    );
  };

  return (
    <div role="tree" aria-label="Workspace files" data-testid="file-tree">
      <button
        type="button"
        className={ROOT_CLASS}
        style={{ ...ROW_STYLE, paddingLeft: treeRowPad(0) }}
        data-testid="tree-root"
        aria-label={`${baseName(root)} (workspace folder)`}
        title={root}
        onClick={() => setSelected(null)}
      >
        <span className="shrink-0 flex items-center">
          <FolderIcon open />
        </span>
        <MiddleEllipsis text={baseName(root)} className="flex-1" />
      </button>
      {renderDir(root, 0)}
    </div>
  );
}
