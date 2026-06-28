/**
 * useUserSettings — wrappande re-export. Implementation ligger numera i
 * @/lib/settings/SettingsContext (React Context-baserad så förändringar
 * propagerar till alla komponenter i samma render-tree).
 *
 * Den här filen behålls som en kompabilitets-shim så att befintliga imports
 * (`import { useUserSettings } from "@/hooks/useUserSettings"`) fortsätter
 * fungera utan att vi behöver söka & ersätta i hela koden.
 */

export { useUserSettings, type SettingsContextValue } from "@/lib/settings/SettingsContext";
export { SettingsProvider } from "@/lib/settings/SettingsContext";
