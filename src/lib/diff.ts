// Minimal Myers character-level diff
// Returns an array of ops: { type: 'equal'|'insert'|'delete', text: string }

export type DiffOp = { type: "equal" | "insert" | "delete"; text: string };

export function diff(oldText: string, newText: string): DiffOp[] {
  const a = oldText.split("");
  const b = newText.split("");
  const n = a.length;
  const m = b.length;
  const max = n + m;

  // v[k] = furthest x reached on diagonal k
  const v: number[] = new Array(2 * max + 1).fill(0);
  const trace: number[][] = [];

  outer: for (let d = 0; d <= max; d++) {
    trace.push([...v]);
    for (let k = -d; k <= d; k += 2) {
      const ki = k + max;
      let x: number;
      if (k === -d || (k !== d && v[ki - 1] < v[ki + 1])) {
        x = v[ki + 1];
      } else {
        x = v[ki - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[ki] = x;
      if (x >= n && y >= m) break outer;
    }
  }

  // Backtrack
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;

  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d];
    const k = x - y;
    const ki = k + max;
    let prevK: number;
    if (k === -d || (k !== d && vd[ki - 1] < vd[ki + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = vd[prevK + max];
    const prevY = prevX - prevK;

    while (x > prevX + 1 && y > prevY + 1) {
      ops.unshift({ type: "equal", text: a[x - 1] });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) {
        ops.unshift({ type: "insert", text: b[y - 1] });
        y--;
      } else {
        ops.unshift({ type: "delete", text: a[x - 1] });
        x--;
      }
    }
    while (x > prevX && y > prevY) {
      ops.unshift({ type: "equal", text: a[x - 1] });
      x--;
      y--;
    }
  }

  // Merge consecutive same-type ops into runs
  const merged: DiffOp[] = [];
  for (const op of ops) {
    const last = merged[merged.length - 1];
    if (last && last.type === op.type) {
      last.text += op.text;
    } else {
      merged.push({ type: op.type, text: op.text });
    }
  }
  return merged;
}
