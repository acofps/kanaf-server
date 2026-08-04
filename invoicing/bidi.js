import reshaper from "arabic-reshaper";

const ARABIC_RANGE = /[\u0600-\u06FF\u0750-\u077F]/;

/**
 * Splits text into runs of "Arabic script" vs "everything else"
 * (digits, Latin letters, punctuation, spaces attached to them).
 * Each run keeps its own correct internal order:
 *   - Arabic runs: reshaped into joined presentation forms, then
 *     character-reversed (so they read correctly left-to-right on
 *     the page, which is how pdfkit lays out any string).
 *   - Non-Arabic runs (numbers, VAT IDs, "SAR", dates): left exactly
 *     as-is — reversing these would corrupt them, which is exactly
 *     the bug caught by testing "الرقم الضريبي: 300123456700003"
 *     before this fix existed.
 * Runs are then reassembled in reverse ORDER (not reverse characters)
 * so the whole line reads correctly right-to-left overall.
 */
function shapeBidiLine(text) {
  const runs = [];
  let current = "";
  let currentIsArabic = null;

  for (const ch of text) {
    const isArabic = ARABIC_RANGE.test(ch);
    // Treat spaces as belonging to whichever run they're adjacent to,
    // not their own run, so words don't get split from their spaces.
    const effectiveIsArabic = ch === " " ? currentIsArabic : isArabic;
    if (currentIsArabic === null) currentIsArabic = effectiveIsArabic ?? isArabic;

    if (effectiveIsArabic === currentIsArabic || ch === " ") {
      current += ch;
    } else {
      runs.push({ text: current, arabic: currentIsArabic });
      current = ch;
      currentIsArabic = isArabic;
    }
  }
  if (current) runs.push({ text: current, arabic: currentIsArabic });

  const processed = runs.map((r) =>
    r.arabic ? reshaper.convertArabic(r.text).split("").reverse().join("") : r.text
  );

  // Visual right-to-left order: reverse the sequence of runs.
  return processed.reverse().join("");
}

export { shapeBidiLine };
