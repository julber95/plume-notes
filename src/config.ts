// Application settings.

// Client ID of the application registered with Microsoft (see docs/GUIDE.md,
// step 2). While it is empty, Plume works locally only, without OneDrive
// sync. It is not a secret.
const CLIENT_ID = '3d29f457-e421-4a20-a180-d8b5c86dda7d'

// (The VITE_MS_CLIENT_ID variable is only used by the automated tests.)
export const MS_CLIENT_ID: string = CLIENT_ID || import.meta.env.VITE_MS_CLIENT_ID || ''

// Name of the folder created at the root of OneDrive.
export const ONEDRIVE_FOLDER = 'Plume'

// Permission requested from Microsoft. "Files.ReadWrite" is the narrowest one
// that allows the Plume folder to live at the root of OneDrive.
export const MS_SCOPES = 'Files.ReadWrite offline_access'

// Personal Microsoft accounts only.
export const MS_AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0'

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
