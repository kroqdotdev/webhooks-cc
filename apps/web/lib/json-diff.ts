export type DiffType = "added" | "removed" | "changed" | "unchanged";

export interface DiffEntry {
  path: string;
  key: string;
  type: DiffType;
  leftValue?: unknown;
  rightValue?: unknown;
}

/**
 * Computes a flat list of diff entries between two JSON values.
 * Returns entries for every leaf, annotated with their diff type.
 */
export function computeJsonDiff(left: unknown, right: unknown): DiffEntry[] {
  const entries: DiffEntry[] = [];
  walk(left, right, "", entries);
  return entries;
}

function walk(left: unknown, right: unknown, path: string, entries: DiffEntry[]): void {
  const leftType = classify(left);
  const rightType = classify(right);

  // Different structural types
  if (leftType !== rightType) {
    entries.push({
      path,
      key: lastKey(path),
      type: "changed",
      leftValue: left,
      rightValue: right,
    });
    return;
  }

  // Both objects
  if (leftType === "object" && rightType === "object") {
    const leftObj = left as Record<string, unknown>;
    const rightObj = right as Record<string, unknown>;
    const allKeys = new Set([...Object.keys(leftObj), ...Object.keys(rightObj)]);

    for (const key of allKeys) {
      const childPath = path ? `${path}.${key}` : key;
      const inLeft = Object.prototype.hasOwnProperty.call(leftObj, key);
      const inRight = Object.prototype.hasOwnProperty.call(rightObj, key);

      if (inLeft && !inRight) {
        entries.push({ path: childPath, key, type: "removed", leftValue: leftObj[key] });
      } else if (!inLeft && inRight) {
        entries.push({ path: childPath, key, type: "added", rightValue: rightObj[key] });
      } else {
        walk(leftObj[key], rightObj[key], childPath, entries);
      }
    }
    return;
  }

  // Both arrays
  if (leftType === "array" && rightType === "array") {
    const leftArr = left as unknown[];
    const rightArr = right as unknown[];
    const maxLen = Math.max(leftArr.length, rightArr.length);

    for (let i = 0; i < maxLen; i++) {
      const childPath = `${path}[${i}]`;
      if (i >= leftArr.length) {
        entries.push({ path: childPath, key: String(i), type: "added", rightValue: rightArr[i] });
      } else if (i >= rightArr.length) {
        entries.push({ path: childPath, key: String(i), type: "removed", leftValue: leftArr[i] });
      } else {
        walk(leftArr[i], rightArr[i], childPath, entries);
      }
    }
    return;
  }

  // Primitives
  if (left === right) {
    entries.push({
      path,
      key: lastKey(path),
      type: "unchanged",
      leftValue: left,
      rightValue: right,
    });
  } else {
    entries.push({ path, key: lastKey(path), type: "changed", leftValue: left, rightValue: right });
  }
}

function classify(value: unknown): "null" | "array" | "object" | "primitive" {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return "primitive";
}

function lastKey(path: string): string {
  if (!path) return "(root)";
  const dotIndex = path.lastIndexOf(".");
  const bracketIndex = path.lastIndexOf("[");
  const lastSep = Math.max(dotIndex, bracketIndex);
  if (lastSep === -1) return path;
  return path.slice(lastSep + 1).replaceAll("]", "");
}

/**
 * Diffs two key-value record maps (headers, query params).
 * Returns entries for every key across both maps.
 */
export function computeMapDiff(
  left: Record<string, string>,
  right: Record<string, string>
): DiffEntry[] {
  const entries: DiffEntry[] = [];
  const allKeys = new Set([...Object.keys(left), ...Object.keys(right)]);

  for (const key of allKeys) {
    const inLeft = Object.prototype.hasOwnProperty.call(left, key);
    const inRight = Object.prototype.hasOwnProperty.call(right, key);

    if (inLeft && !inRight) {
      entries.push({ path: key, key, type: "removed", leftValue: left[key] });
    } else if (!inLeft && inRight) {
      entries.push({ path: key, key, type: "added", rightValue: right[key] });
    } else if (left[key] === right[key]) {
      entries.push({
        path: key,
        key,
        type: "unchanged",
        leftValue: left[key],
        rightValue: right[key],
      });
    } else {
      entries.push({
        path: key,
        key,
        type: "changed",
        leftValue: left[key],
        rightValue: right[key],
      });
    }
  }

  return entries;
}
