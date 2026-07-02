class MinHeap {
  constructor() {
    this.data = [];
  }

  push(val) {
    this.data.push(val);
    this._up(this.data.length - 1);
  }

  pop() {
    if (this.data.length === 0) return null;
    const top = this.data[0];
    const bottom = this.data.pop();
    if (this.data.length > 0) {
      this.data[0] = bottom;
      this._down(0);
    }
    return top;
  }

  size() {
    return this.data.length;
  }

  _up(i) {
    while (i > 0) {
      const p = Math.floor((i - 1) / 2);
      if (this.data[i][0] < this.data[p][0]) {
        const tmp = this.data[i];
        this.data[i] = this.data[p];
        this.data[p] = tmp;
        i = p;
      } else {
        break;
      }
    }
  }

  _down(i) {
    const len = this.data.length;
    while (i * 2 + 1 < len) {
      let left = i * 2 + 1;
      let right = left + 1;
      let best = left;
      if (right < len && this.data[right][0] < this.data[left][0]) {
        best = right;
      }
      if (this.data[best][0] < this.data[i][0]) {
        const tmp = this.data[i];
        this.data[i] = this.data[best];
        this.data[best] = tmp;
        i = best;
      } else {
        break;
      }
    }
  }
}

export function findShortestPath(grid, start, end) {
  const rows = grid.length;
  const cols = grid[0].length;

  const dist = Array.from({ length: rows }, () => Array(cols).fill(Infinity));
  dist[start.r][start.c] = 0;

  const heap = new MinHeap();
  heap.push([0, start.r, start.c]);

  const dirs = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1]
  ];

  while (heap.size() > 0) {
    const [d, r, c] = heap.pop();

    if (r === end.r && c === end.c) {
      return d === Infinity ? null : d;
    }

    if (d > dist[r][c]) {
      continue;
    }

    for (const [dr, dc] of dirs) {
      const nr = r + dr;
      const nc = c + dc;

      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
        const weight = grid[nr][nc];
        if (weight === Infinity) continue;
        const nextDist = d + weight;

        if (nextDist < dist[nr][nc]) {
          dist[nr][nc] = nextDist;
          heap.push([nextDist, nr, nc]);
        }
      }
    }
  }

  return null;
}
