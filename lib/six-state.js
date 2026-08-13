function inferPlanSubmissionState({
  messages = [],
  submitVisible = false,
  withdrawVisible = false,
}) {
  if (withdrawVisible) return "submitted";
  if (submitVisible) return "editable";

  const awaitingAdvisorApproval = messages.some((message) =>
    /(?:memperoleh|menunggu) persetujuan rencana studi/i.test(message),
  );
  if (awaitingAdvisorApproval) return "submitted";

  return "unknown";
}

module.exports = { inferPlanSubmissionState };
