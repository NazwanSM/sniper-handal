function formatSeconds(milliseconds) {
  const seconds = milliseconds / 1000;
  const displayed = Number.isInteger(seconds) ? seconds : seconds.toFixed(1);
  return `${displayed} detik`;
}

module.exports = { formatSeconds };
