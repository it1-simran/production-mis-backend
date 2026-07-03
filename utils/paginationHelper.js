module.exports = (page = 1, limit = 50) => {
  const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
  return { skip, limit: Number(limit) };
};
