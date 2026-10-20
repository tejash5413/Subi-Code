// Query subset used by the paid-period adapter; no network or credentials.
function fundingQuery(state, prefix, filters = [], field, direction = 'asc', count = 100) {
  return {
    where: (key, op, value) => fundingQuery(state, prefix, [...filters, [key, op, value]], field, direction, count),
    orderBy: (key, dir) => fundingQuery(state, prefix, filters, key, dir, count),
    limit: n => fundingQuery(state, prefix, filters, field, direction, n),
    get: async () => ({ docs: Object.entries(state).filter(([key, data]) => key.startsWith(prefix + '/') && !key.slice(prefix.length + 1).includes('/') && filters.every(([f, op, v]) => op === '<=' ? data[f] <= v : op === '>' ? data[f] > v : data[f] === v)).sort((a, b) => (a[1][field] - b[1][field]) * (direction === 'desc' ? -1 : 1)).slice(0, count).map(([key, data]) => ({ id: key.slice(prefix.length + 1), data: () => data })) }),
  };
}
module.exports = { fundingQuery };
