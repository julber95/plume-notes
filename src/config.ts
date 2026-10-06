// Réglages de l'application.

// Identifiant client de l'application enregistrée chez Microsoft (voir
// docs/GUIDE.md, étape 1). Tant qu'il est vide, Plume fonctionne uniquement en
// local, sans synchronisation OneDrive. Ce n'est pas un secret.
const CLIENT_ID = ''

// (La variable VITE_MS_CLIENT_ID ne sert qu'aux tests automatisés.)
export const MS_CLIENT_ID: string = CLIENT_ID || import.meta.env.VITE_MS_CLIENT_ID || ''

// Nom du dossier créé à la racine de OneDrive.
export const ONEDRIVE_FOLDER = 'Plume'

// Permission demandée à Microsoft. « Files.ReadWrite » est la plus étroite qui
// permette de placer le dossier Plume à la racine de OneDrive.
export const MS_SCOPES = 'Files.ReadWrite offline_access'

// Comptes Microsoft personnels uniquement.
export const MS_AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0'

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
