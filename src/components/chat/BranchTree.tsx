"use client";

import { useEffect, useState } from "react";

type TreeNode = {
  id: string;
  title: string;
  parentConversationId: string | null;
  branchPointMessageId: string | null;
  mode: string | null;
};

type Props = {
  conversationId: string | null;
  activeId: string | null;
  onSelect: (id: string) => void;
  // Bump this to force a refetch (e.g. after creating a new branch).
  refreshKey?: number;
};

function buildChildren(nodes: TreeNode[]) {
  const children = new Map<string | null, TreeNode[]>();
  for (const n of nodes) {
    const key = n.parentConversationId;
    const list = children.get(key) ?? [];
    list.push(n);
    children.set(key, list);
  }
  return children;
}

function TreeRow({
  node, children, activeId, depth, onSelect,
}: {
  node: TreeNode;
  children: Map<string | null, TreeNode[]>;
  activeId: string | null;
  depth: number;
  onSelect: (id: string) => void;
}) {
  const kids = children.get(node.id) ?? [];
  return (
    <>
      <button
        className={`branch-node${node.id === activeId ? " active" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onSelect(node.id)}
        title={node.title}
      >
        <span className="branch-glyph">{depth === 0 ? "●" : "⑂"}</span>
        <span className="branch-title">{node.title}</span>
      </button>
      {kids.map((k) => (
        <TreeRow key={k.id} node={k} children={children} activeId={activeId} depth={depth + 1} onSelect={onSelect} />
      ))}
    </>
  );
}

export default function BranchTree({ conversationId, activeId, onSelect, refreshKey }: Props) {
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [rootId, setRootId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (!conversationId) { setNodes([]); setRootId(null); return; }
    let cancelled = false;
    fetch(`/api/conversations/${conversationId}/tree`)
      .then((r) => r.json())
      .then((data: { rootId?: string; nodes?: TreeNode[] }) => {
        if (cancelled) return;
        setNodes(Array.isArray(data?.nodes) ? data.nodes : []);
        setRootId(data?.rootId ?? null);
      })
      .catch(() => { if (!cancelled) { setNodes([]); setRootId(null); } });
    return () => { cancelled = true; };
  }, [conversationId, refreshKey]);

  // Nothing to show unless this conversation is part of a multi-node tree.
  if (nodes.length < 2 || !rootId) return null;

  const children = buildChildren(nodes);
  const root = nodes.find((n) => n.id === rootId);
  if (!root) return null;

  return (
    <div className="branch-tree">
      <button className="branch-tree-head" onClick={() => setCollapsed((v) => !v)}>
        <span>{collapsed ? "▸" : "▾"}</span>
        <span>Branches ({nodes.length})</span>
      </button>
      {!collapsed && (
        <div className="branch-tree-body">
          <TreeRow node={root} children={children} activeId={activeId} depth={0} onSelect={onSelect} />
        </div>
      )}
    </div>
  );
}
