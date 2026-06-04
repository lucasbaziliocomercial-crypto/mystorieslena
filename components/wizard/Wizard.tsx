"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useWizard } from "@/store/wizard";
import { useTabs } from "@/store/tabs";
import { getRoteiro } from "@/lib/storage";
import { StepIndicator } from "./StepIndicator";
import { StepShell } from "./StepShell";
import { ProjectTabs } from "@/components/tabs/ProjectTabs";
import { UpdateButton } from "./UpdateButton";
import { STEP_ORDER } from "@/types/roteiro";
import { CATEGORIES } from "@/lib/categories";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Pencil } from "lucide-react";

interface Props {
  id: string;
}

export function Wizard({ id }: Props) {
  const router = useRouter();
  const roteiro = useWizard((s) => s.roteiro);
  const setRoteiro = useWizard((s) => s.setRoteiro);
  const setCurrentStep = useWizard((s) => s.setCurrentStep);
  const setTitle = useWizard((s) => s.setTitle);
  const reset = useWizard((s) => s.reset);
  const openTab = useTabs((s) => s.openTab);

  const [notFound, setNotFound] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  useEffect(() => {
    const r = getRoteiro(id);
    if (!r) {
      setNotFound(true);
      return;
    }
    setRoteiro(r);
    return () => reset();
  }, [id, setRoteiro, reset]);

  // Mantém a guia (aba) deste projeto aberta e o título em sincronia. Persiste
  // em `veludo:tabs` — ao reabrir o app, as guias dos projetos simultâneos voltam.
  const roteiroTitle = roteiro?.title;
  useEffect(() => {
    if (roteiroTitle) openTab(id, roteiroTitle);
  }, [id, roteiroTitle, openTab]);

  if (notFound) {
    return (
      <div className="max-w-xl mx-auto py-24 text-center flex flex-col items-center gap-4">
        <h1 className="text-2xl font-serif">Roteiro não encontrado</h1>
        <p className="text-sm text-muted-foreground">
          O roteiro <code>{id}</code> não existe ou foi removido.
        </p>
        <Button onClick={() => router.push("/")}>Voltar à home</Button>
      </div>
    );
  }

  if (!roteiro) {
    return (
      <div className="max-w-xl mx-auto py-24 text-center">
        <p className="text-sm text-muted-foreground">Carregando roteiro...</p>
      </div>
    );
  }

  const completed = STEP_ORDER.filter(
    (s) => !!roteiro.outputs[s]?.content,
  );

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-12 flex flex-col gap-8">
      <ProjectTabs activeId={id} />

      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Link href="/">
            <Button variant="ghost" size="sm" className="gap-1">
              <ArrowLeft className="size-4" /> Roteiros
            </Button>
          </Link>
          {editingTitle ? (
            <div className="flex items-center gap-2 flex-1 max-w-md">
              <Input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    setTitle(titleDraft.trim() || roteiro.title);
                    setEditingTitle(false);
                  }
                  if (e.key === "Escape") setEditingTitle(false);
                }}
                className="h-9"
              />
              <Button
                size="sm"
                onClick={() => {
                  setTitle(titleDraft.trim() || roteiro.title);
                  setEditingTitle(false);
                }}
              >
                Salvar
              </Button>
            </div>
          ) : (
            <button
              onClick={() => {
                setTitleDraft(roteiro.title);
                setEditingTitle(true);
              }}
              className="group flex items-center gap-2 min-w-0 px-2 py-1 rounded-md hover:bg-muted transition"
            >
              <span className="font-serif text-lg truncate">
                {roteiro.title}
              </span>
              <Pencil className="size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition" />
            </button>
          )}
          <Badge variant="outline" className="font-normal shrink-0">
            {CATEGORIES[roteiro.category].label}
          </Badge>
        </div>

        <UpdateButton />
      </header>

      <StepIndicator
        current={roteiro.currentStep}
        completed={completed}
        onSelect={(s) => setCurrentStep(s)}
      />

      <StepShell step={roteiro.currentStep} />
    </div>
  );
}
