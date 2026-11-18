import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import { api } from "./api";

type Entry = { path: string; name: string };
type Page = { path: string; entries: Entry[]; next: number | null };
type BrowseProps = { host: string; selected: string; onSelect: (path: string) => void };

function DirectoryChildren({ host, path, selected, onSelect }: BrowseProps & { path?: string }) {
  const [page, setPage] = useState<Page>();
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let mounted = true;
    const query = new URLSearchParams({ offset: String(offset) });
    if (path) query.set("cwd", path);
    setLoading(true);
    setError("");
    void api<Page>(`/hosts/${encodeURIComponent(host)}/directories?${query}`)
      .then((result) => {
        if (mounted)
          setPage((prior) => ({
            ...result,
            entries: offset && prior ? [...prior.entries, ...result.entries] : result.entries,
          }));
      })
      .catch((e: unknown) => {
        if (mounted) setError(e instanceof Error ? e.message : "无法读取目录");
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [host, path, offset]);
  return (
    <div className="directory-children">
      {!path && page && (
        <button
          type="button"
          className="directory-choice"
          title={page.path}
          onClick={() => onSelect(page.path)}
        >
          <Folder size={15} /> {page.path}
        </button>
      )}
      {page?.entries.map((entry) => (
        <DirectoryBranch
          key={entry.path}
          host={host}
          entry={entry}
          selected={selected}
          onSelect={onSelect}
        />
      ))}
      {!loading && !error && page && !page.entries.length && <small>没有子目录</small>}
      {loading && <small role="status">正在读取目录…</small>}
      {error && <small role="alert">{error}</small>}
      {!error && page?.next != null && (
        <button
          type="button"
          className="button"
          disabled={loading}
          onClick={() => setOffset(page.next!)}
        >
          显示更多目录
        </button>
      )}
    </div>
  );
}

function DirectoryBranch({ host, entry, selected, onSelect }: BrowseProps & { entry: Entry }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="directory-branch">
      <div className={`directory-row ${selected === entry.path ? "selected" : ""}`}>
        <button
          type="button"
          className="directory-expand"
          aria-expanded={open}
          aria-label={`${open ? "折叠" : "展开"} ${entry.name}`}
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        <button
          type="button"
          className="directory-choice"
          title={entry.path}
          onClick={() => onSelect(entry.path)}
        >
          <Folder size={15} /> {entry.name}
        </button>
      </div>
      {open && (
        <DirectoryChildren host={host} path={entry.path} selected={selected} onSelect={onSelect} />
      )}
    </div>
  );
}

export function DirectoryInput({
  host,
  value,
  onChange,
  initiallyOpen = false,
}: {
  host: string;
  value: string;
  onChange: (path: string) => void;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <div className="directory-field">
      <div className="directory-field-row">
        <label>
          工作目录
          <input value={value} onChange={(e) => onChange(e.target.value)} required />
        </label>
        <button
          className="button"
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Folder size={15} /> 浏览
        </button>
      </div>
      {open && (
        <div className="directory-browser" role="group" aria-label="工作目录树">
          <DirectoryChildren key={host} host={host} selected={value} onSelect={onChange} />
        </div>
      )}
    </div>
  );
}
