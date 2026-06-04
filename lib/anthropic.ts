export const MODELS = {
  // Apelido "opus" flutuante: o SDK resolve para o Opus mais recente (4.8),
  // que tem saída mais rápida. Usado em todos os steps — manter como apelido
  // garante velocidade sem precisar atualizar o ID a cada release.
  opus: "opus",
  sonnet: "sonnet",
  haiku: "haiku",
} as const;

export const DEFAULT_MODEL = MODELS.sonnet;
