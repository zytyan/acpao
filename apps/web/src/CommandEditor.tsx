import { useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { history, historyKeymap, isolateHistory, undo } from "@codemirror/commands";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { formatPastedWindowsPath } from "../../../packages/core/src/agent-command";

const commandHighlight = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.function(tags.variableName), tags.special(tags.variableName)],
    color: "var(--shell-command)",
  },
  {
    tag: [tags.variableName, tags.operator, tags.number, tags.bool],
    color: "var(--shell-parameter)",
  },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--shell-string)" },
  { tag: tags.comment, color: "var(--muted)" },
]);

export function CommandEditor({
  initial,
  windows,
  onChange,
}: {
  initial: string;
  windows: boolean;
  onChange: (value: string) => void;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  const change = useRef(onChange);
  const [rewritten, setRewritten] = useState<string | null>(null);
  const automatic = useRef(false);
  change.current = onChange;
  useEffect(() => {
    const editor = new EditorView({
      parent: mount.current!,
      state: EditorState.create({
        doc: initial,
        extensions: [
          history(),
          keymap.of([
            ...historyKeymap,
            {
              key: "Enter",
              run: (instance) => {
                instance.dom.closest("form")?.requestSubmit();
                return true;
              },
            },
          ]),
          StreamLanguage.define(shell),
          syntaxHighlighting(commandHighlight),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": "启动命令" }),
          EditorView.domEventHandlers({
            paste: (event, instance) => {
              if (!windows || instance.state.doc.length !== 0) return false;
              const original = event.clipboardData?.getData("text/plain") ?? "";
              const formatted = formatPastedWindowsPath(original);
              if (!formatted) return false;
              event.preventDefault();
              automatic.current = true;
              instance.dispatch({
                changes: { from: 0, insert: formatted },
                annotations: isolateHistory.of("full"),
              });
              setRewritten(original);
              return true;
            },
          }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            change.current(update.state.doc.toString());
            if (automatic.current) automatic.current = false;
            else setRewritten(null);
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      view.current = null;
      editor.destroy();
    };
  }, [initial, windows]);
  return (
    <div className="command-editor-wrap">
      <div ref={mount} className="command-editor" />
      {rewritten !== null && (
        <div className="command-edit-bubble">
          <span role="status">已将 Windows 路径整理为可运行的命令</span>
          <button
            type="button"
            aria-label="撤销 Windows 路径整理"
            onClick={() => {
              if (view.current) undo(view.current);
              setRewritten(null);
              view.current?.focus();
            }}
          >
            撤销
          </button>
        </div>
      )}
    </div>
  );
}
