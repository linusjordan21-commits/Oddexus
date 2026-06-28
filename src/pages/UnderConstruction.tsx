import { useNavigate } from "react-router-dom";
import { Construction, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BrandHeader } from "@/components/BrandHeader";

/**
 * Under Construction-sida.
 *
 * Visas för vanliga kunder (icke-admin) som försöker komma åt delar av
 * sajten som inte är öppna för dem ännu. Endast Autoclicker är öppen.
 * Root-admin har fri åtkomst till alla rutter och ser aldrig den här
 * sidan om hen inte explicit navigerar till /under-construction.
 */
export default function UnderConstruction() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-secondary/10 to-accent/10">
      <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 md:px-8">
        <BrandHeader className="mb-8" />

        <Card>
          <CardContent className="flex flex-col items-center gap-6 p-10 text-center">
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-amber-500/15 ring-1 ring-amber-500/30">
              <Construction className="h-10 w-10 text-amber-400" aria-hidden />
            </div>

            <div className="space-y-3">
              <h1 className="text-2xl font-bold sm:text-3xl">Under construction</h1>
              <p className="text-sm text-muted-foreground sm:text-base">
                Den här delen av plattformen är inte öppen ännu.
                <br />
                Just nu har du endast tillgång till Autoclicker.
              </p>
            </div>

            <Button
              size="lg"
              className="mt-2"
              onClick={() => navigate("/autoclicker")}
            >
              Gå till Autoclicker
              <ArrowRight className="ml-2 h-4 w-4" aria-hidden />
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
