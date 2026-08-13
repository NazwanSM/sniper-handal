function parseTargetCapacityFromHtml(html, target) {
  const pageText = htmlToText(html);
  if (!new RegExp(`\\b${escapeRegExp(target.courseCode)}\\b`, "i").test(pageText)) {
    throw new Error(
      `Dokumen target tidak memuat ${target.courseCode}; session mungkin kedaluwarsa atau URL salah.`,
    );
  }

  const cards = extractNoticeCards(html);
  const matchingCards = cards.filter((cardHtml) => {
    if (target.sectionNumber) {
      const displayedNumber = htmlToText(cardHtml).match(/^(\d{1,3})\b/)?.[1];
      return (
        displayedNumber &&
        normalizeSectionNumber(displayedNumber) ===
          normalizeSectionNumber(target.sectionNumber)
      );
    }

    return new RegExp(
      `\\bid=["']${escapeRegExp(String(target.classId))}["']`,
      "i",
    ).test(cardHtml);
  });

  if (matchingCards.length !== 1) {
    const selectorDescription = target.sectionNumber
      ? `kelas ${target.sectionNumber}`
      : `tombol id ${target.classId}`;
    throw new Error(
      `Kartu ${selectorDescription} ditemukan ${matchingCards.length} kali pada HTML ${target.courseCode}.`,
    );
  }

  const cardHtml = matchingCards[0];
  const cardText = htmlToText(cardHtml);
  const quota = Number((cardText.match(/\bKuota\s*(\d+)/i) || [])[1]);
  const applicants = Number(
    (cardText.match(/\bPendaftar\s*(\d+)/i) || [])[1],
  );
  const buttonId =
    (cardHtml.match(/\bid=["'](form_add:[^"']+)["']/i) || [])[1] || null;

  if (!Number.isFinite(quota) || !Number.isFinite(applicants)) {
    throw new Error(`Kuota ${target.label} tidak dapat dibaca dari HTML SIX.`);
  }
  if (!/\bAmbil\b/i.test(cardText) && !buttonId) {
    throw new Error(`Tombol Ambil ${target.label} tidak ditemukan pada HTML SIX.`);
  }

  return { quota, applicants, available: quota - applicants, buttonId };
}

function extractFullCourseCodes(messages) {
  const courseCodes = new Set();
  for (const message of messages) {
    const fullSection = message.match(
      /kelas penuh\s*:\s*([\s\S]*?)(?:silakan|$)/i,
    )?.[1];
    if (!fullSection) continue;

    for (const match of fullSection.matchAll(/\b[A-Z]{2,6}\s?\d{3,5}[A-Z]?\b/gi)) {
      courseCodes.add(match[0].replace(/\s+/g, "").toUpperCase());
    }
  }
  return [...courseCodes];
}

function extractNoticeCards(html) {
  const pattern = /<[^>]+\bclass=["']([^"']*)["'][^>]*>/gi;
  const starts = [...html.matchAll(pattern)]
    .filter((match) => {
      const classes = match[1].split(/\s+/);
      return classes.includes("list-group-item") && classes.includes("notice");
    })
    .map((match) => match.index);
  return starts.map((start, index) =>
    html.slice(start, starts[index + 1] ?? html.length),
  );
}

function htmlToText(html) {
  return decodeHtmlEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value) {
  const named = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
  return value.replace(
    /&(#x[\da-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi,
    (entity, code) => {
      if (code.startsWith("#x")) {
        return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
      }
      if (code.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
      }
      return named[code.toLowerCase()] ?? entity;
    },
  );
}

function sanitizeTargetHtml(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi, "");
}

function normalizeSectionNumber(value) {
  const number = Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(number)) throw new Error(`Nomor kelas tidak valid: ${value}`);
  return String(number);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  escapeRegExp,
  extractFullCourseCodes,
  normalizeSectionNumber,
  parseTargetCapacityFromHtml,
  sanitizeTargetHtml,
};
