import x3000Logo from "@/assets/x3000-logo.png";
import goldenBullLogo from "@/assets/goldenbull-logo.png";
import vbetLogo from "@/assets/vbet-logo.png";
import onextwLogo from "@/assets/1x2-logo.png";
import speedybetLogo from "@/assets/speedybet-logo.png";
import snabbareLogo from "@/assets/snabbare-logo.png";
import comeonLogo from "@/assets/comeon-logo.png";
import bethardLogo from "@/assets/bethard-logo.png";
import spelklubbenLogo from "@/assets/spelklubben-logo.png";
import bet365Logo from "@/assets/bet365-logo.png";
import unibetLogo from "@/assets/unibet-logo.png";
import hajperLogo from "@/assets/hajper-logo.png";
import dbetLogo from "@/assets/dbet-logo.png";
import mrvegasLogo from "@/assets/mrvegas-logo.png";
import megarichesLogo from "@/assets/megariches-logo.png";
import betssonLogo from "@/assets/betsson-logo.png";

const LOGO_MAP: Record<string, string> = {
  X3000: x3000Logo,
  "Golden Bull": goldenBullLogo,
  VBET: vbetLogo,
  "1x2": onextwLogo,
  SpeedyBet: speedybetLogo,
  /** Alias used by bonus optimizer display names */
  Speedybet: speedybetLogo,
  Snabbare: snabbareLogo,
  ComeOn: comeonLogo,
  Bethard: bethardLogo,
  "Spel Klubben": spelklubbenLogo,
  Spelklubben: spelklubbenLogo,
  Bet365: bet365Logo,
  Unibet: unibetLogo,
  Hajper: hajperLogo,
  DBET: dbetLogo,
  MrVegas: mrvegasLogo,
  Megariches: megarichesLogo,
  MegaRiches: megarichesLogo,
  Betsson: betssonLogo,
};

const SIZE_OVERRIDES: Record<string, string> = {
  Unibet: "max-h-6",
  Bet365: "max-h-7",
  DBET: "max-h-7",
  "1x2": "max-h-6",
  X3000: "max-h-7",
  "Golden Bull": "max-h-11",
  SpeedyBet: "max-h-11",
  Speedybet: "max-h-11",
  "Spel Klubben": "max-h-12",
  Spelklubben: "max-h-12",
  ComeOn: "max-h-7",
  MegaRiches: "max-h-7",
};

const BookmakerName = ({ name, className = "w-36" }: { name: string; className?: string }) => {
  const logo = LOGO_MAP[name];
  if (logo) {
    const maxH = SIZE_OVERRIDES[name] || "max-h-9";
    return <span className={`${className} inline-flex items-center overflow-hidden`}><img src={logo} alt={name} className={`h-full w-full ${maxH} object-contain object-left`} /></span>;
  }
  return <span className={`${className} font-semibold text-sm text-foreground`}>{name}</span>;
};

export default BookmakerName;
