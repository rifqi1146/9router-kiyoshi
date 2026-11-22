// Providers place cache reads in different slots. Reading only the top-level
// key is what made every Antigravity row render an em dash in this table even
// when 20k of 22k prompt tokens were cached (Gemini reports it nested).
export function getCachedTokens(tokens) {
  if (!tokens || typeof tokens !== "object") return 0;
  return (
    tokens.cached_tokens ||
    tokens.cache_read_input_tokens ||
    tokens.prompt_tokens_details?.cached_tokens ||
    tokens.input_tokens_details?.cached_tokens ||
    0
  );
}

export function getCacheCreationTokens(tokens) {
  return tokens?.cache_creation_input_tokens || 0;
}

export function getInputTokens(tokens) {
  const prompt = tokens?.prompt_tokens || tokens?.input_tokens || 0;
  // Canonical storage keeps prompt cache-inclusive. Legacy Claude rows may have
  // stored prompt cache-exclusive; fall back to cache when it's larger so old
  // rows don't under-report input.
  const cache = getCachedTokens(tokens);
  return prompt < cache ? cache : prompt;
}

export function getOutputTokens(tokens) {
  // Translators store usage in either OpenAI field names
  // (completion_tokens) or Claude field names (output_tokens) — issue #3890.
  return tokens?.completion_tokens || tokens?.output_tokens || 0;
}
