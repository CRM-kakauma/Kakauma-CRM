import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCrm } from "@/lib/crm-api";
import {
  AUDIENCE_HINT,
  AUDIENCE_LABEL,
  WEEKDAYS,
  describeSchedule,
  type BroadcastConfig,
} from "@/lib/crm-broadcast";
import { cn } from "@/lib/utils";

function Choice({
  active,
  title,
  hint,
  onClick,
}: {
  active: boolean;
  title: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-lg border px-3 py-2 text-left text-sm transition-colors",
        active
          ? "border-primary bg-primary/5 font-medium text-foreground"
          : "border-border text-muted-foreground hover:border-primary/40",
      )}
    >
      {title}
      {hint && <span className="mt-0.5 block text-[11px] font-normal leading-snug">{hint}</span>}
    </button>
  );
}

/** The trigger of a disparo: who receives, when, and how often per customer. */
export function BroadcastSettings({
  value,
  onChange,
}: {
  value: BroadcastConfig;
  onChange: (v: BroadcastConfig) => void;
}) {
  const { data: segments = [] } =
    useCrm<{ key: string; name: string; size?: number }[]>("crm_list_segments");
  const s = value.schedule;
  const [day = "", time = "10:00"] = s.mode === "once" ? s.at.split("T") : ["", s.time];
  const days = s.mode === "daily" ? (s.days ?? []) : [];
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });

  return (
    <div className="space-y-4">
      <div className="grid gap-1.5">
        <Label>Segmento</Label>
        <Select value={value.segment} onValueChange={(v) => onChange({ ...value, segment: v })}>
          <SelectTrigger>
            <SelectValue placeholder="Escolha quem vai receber" />
          </SelectTrigger>
          <SelectContent>
            {segments.map((g) => (
              <SelectItem key={g.key} value={g.key}>
                {g.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] leading-snug text-muted-foreground">
          Todos que estiverem no segmento na hora do disparo entram no fluxo.
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label>Quando dispara</Label>
        <div className="grid grid-cols-2 gap-2">
          <Choice
            active={s.mode === "once"}
            title="Uma vez"
            hint="Num dia e horário"
            onClick={() =>
              s.mode !== "once" &&
              onChange({ ...value, schedule: { mode: "once", at: `${today}T${time || "10:00"}` } })
            }
          />
          <Choice
            active={s.mode === "daily"}
            title="Todo dia"
            hint="No mesmo horário"
            onClick={() =>
              s.mode !== "daily" &&
              onChange({ ...value, schedule: { mode: "daily", time: time || "10:00" } })
            }
          />
        </div>
        {s.mode === "once" ? (
          <div className="grid grid-cols-[1fr_7rem] gap-2">
            <Input
              type="date"
              aria-label="Dia"
              min={today}
              value={day}
              onChange={(e) =>
                onChange({ ...value, schedule: { mode: "once", at: `${e.target.value}T${time}` } })
              }
            />
            <Input
              type="time"
              aria-label="Horário"
              value={time}
              onChange={(e) =>
                onChange({ ...value, schedule: { mode: "once", at: `${day}T${e.target.value}` } })
              }
            />
          </div>
        ) : (
          <>
            <Input
              type="time"
              aria-label="Horário"
              className="w-32"
              value={time}
              onChange={(e) =>
                onChange({ ...value, schedule: { mode: "daily", time: e.target.value, days } })
              }
            />
            <div className="flex flex-wrap gap-1">
              {WEEKDAYS.map((w, i) => {
                const on = days.length === 0 || days.includes(i);
                return (
                  <button
                    key={w}
                    type="button"
                    aria-pressed={on}
                    onClick={() => {
                      const base = days.length === 0 ? [0, 1, 2, 3, 4, 5, 6] : days;
                      const next = on ? base.filter((d) => d !== i) : [...base, i].sort();
                      if (next.length === 0) return; // at least one day
                      onChange({
                        ...value,
                        schedule: { mode: "daily", time, days: next.length === 7 ? [] : next },
                      });
                    }}
                    className={cn(
                      "h-7 w-10 rounded-md border text-xs",
                      on
                        ? "border-primary bg-primary/10 font-medium text-primary"
                        : "border-border text-muted-foreground",
                    )}
                  >
                    {w}
                  </button>
                );
              })}
            </div>
          </>
        )}
        <p className="text-[11px] leading-snug text-muted-foreground">
          {describeSchedule(s)} (horário de Brasília). Só dispara com o disparo publicado e ativo.
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label>Quantas vezes cada cliente recebe</Label>
        {(["once_ever", "once_per_journey"] as const).map((a) => (
          <Choice
            key={a}
            active={value.audience === a}
            title={AUDIENCE_LABEL[a]}
            hint={AUDIENCE_HINT[a]}
            onClick={() => onChange({ ...value, audience: a })}
          />
        ))}
      </div>
    </div>
  );
}
