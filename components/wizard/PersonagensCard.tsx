"use client";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useWizard } from "@/store/wizard";

/**
 * Card "Nomes dos Personagens" — aparece dentro do step Premissa, logo abaixo
 * do conteúdo da premissa (antes do Cânone), pra a roteirista digitar/colar
 * MANUALMENTE até ~10 nomes de personagens. Trava nomes/sobrenomes pra evitar
 * conflito ao longo da história (o modelo escorrega: "Helena"→"Helen", repete
 * primeiro nome, empilha sobrenome).
 *
 * Diferente do Cânone (gerado por IA, gasta cota da equipe, mais amplo): este
 * é manual, custo zero. Ao clicar "Validar", os nomes passam a ser injetados
 * em Estrutura/Escrita/Revisor como bloco travado (reusando as REGRAS DE NOMES
 * do CANONE_RULE). É ADVISORY — nunca bloqueia o avanço pra Estrutura.
 */
export function PersonagensCard() {
  const roteiro = useWizard((s) => s.roteiro);
  const setPersonagens = useWizard((s) => s.setPersonagens);
  const validarPersonagens = useWizard((s) => s.validarPersonagens);
  const clearPersonagens = useWizard((s) => s.clearPersonagens);

  if (!roteiro) return null;

  const personagens = roteiro.personagens ?? "";
  const validados = !!roteiro.personagensValidados;
  const hasPersonagens = personagens.trim().length > 0;
  // Conta nomes preenchidos (linhas não-vazias) pra um aviso suave de "até 10".
  const nameCount = personagens
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0).length;

  return (
    <Card className="border-violet-200 bg-violet-50/30 dark:border-violet-900/40 dark:bg-violet-950/20">
      <CardHeader>
        <CardTitle>Nomes dos Personagens</CardTitle>
        <CardDescription>
          Liste os nomes (e sobrenomes) dos personagens — um por linha, até 10.
          Pode pôr <strong>só o nome</strong> (a automação distribui as funções
          pela premissa) ou já indicar o papel pra travar (ex.:{" "}
          <code>MMC: Gabriel</code>, <code>Vilã: Beatriz</code>). Depois clique
          em <strong>Validar</strong>: os nomes viram referência fixa em todos
          os próximos steps (Estrutura, Escrita e Revisor), sem o modelo trocar
          ou misturar nomes ao longo da história. Campo opcional — não trava o
          avanço.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <Textarea
          value={personagens}
          onChange={(e) => setPersonagens(e.target.value)}
          placeholder={
            "Um por linha — ex.:\n" +
            "MMC: Gabriel Veloso\n" +
            "FMC: Marina Costa\n" +
            "Vilã: Beatriz Antunes\n" +
            "Melhor amiga: Lara"
          }
          className="min-h-[160px] font-mono text-xs"
        />

        <div className="flex flex-wrap items-center gap-2">
          {validados ? (
            <span className="inline-flex items-center gap-1 rounded-md bg-emerald-100 px-2 py-1 text-xs font-medium text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100">
              ✓ Nomes validados
            </span>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={validarPersonagens}
              disabled={!hasPersonagens}
            >
              Validar
            </Button>
          )}

          {hasPersonagens && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                if (confirm("Limpar os nomes dos personagens?")) {
                  clearPersonagens();
                }
              }}
            >
              Limpar
            </Button>
          )}

          {hasPersonagens && (
            <span className="text-xs text-muted-foreground">
              {nameCount} {nameCount === 1 ? "nome" : "nomes"}
            </span>
          )}
        </div>

        {nameCount > 10 && (
          <p className="text-xs text-amber-900/80 dark:text-amber-100/70">
            ⚠️ Você listou {nameCount} nomes — o combinado é até 10. Pode validar
            assim mesmo, mas listas muito longas perdem força.
          </p>
        )}

        {hasPersonagens && !validados && (
          <p className="text-xs text-violet-900/80 dark:text-violet-100/70">
            Clique em <strong>Validar</strong> pra travar os nomes e ativar a
            injeção na geração. Enquanto não validar, os nomes ficam salvos mas
            NÃO entram nos próximos steps.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
