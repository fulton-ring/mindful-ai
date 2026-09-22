import type { AppConfig } from '@walden/contracts';
import { DEFAULT_PERSONAS } from '@walden/contracts';
import { DeleteThreadDialog } from '../../features/chat/DeleteThreadDialog';
import { PersonaEditor } from '../../features/personas/PersonaEditor';
import { SettingsPanel } from '../../features/settings/SettingsPanel';
import type { WorkspaceData } from '../data/app-types';

export function WorkspaceOverlays({ data, config }: { data: WorkspaceData; config: AppConfig }) {
  return (
    <>
      <PersonaOverlay data={data} />
      <ThreadDeleteOverlay data={data} />
      <NoteDeleteOverlay data={data} />
      <SettingsOverlay data={data} config={config} />
      <SidebarScrim data={data} />
    </>
  );
}

function PersonaOverlay({ data }: { data: WorkspaceData }) {
  const { personaEditing, personas, savePersona, deleteEditingPersona, setPersonaEditing } = data;
  if (!personaEditing) return null;
  return (
    <PersonaEditor
      persona={personaEditing}
      onSave={savePersona}
      onDelete={personas.length <= 1 ? undefined : deleteEditingPersona}
      onClose={() => setPersonaEditing(null)}
    />
  );
}

function ThreadDeleteOverlay({ data }: { data: WorkspaceData }) {
  const { threadToDelete, deleteConversation, setThreadToDelete } = data;
  if (!threadToDelete) return null;
  return (
    <DeleteThreadDialog
      title={threadToDelete.thread.title}
      mode={threadToDelete.mode}
      pending={deleteConversation.isPending}
      error={
        deleteConversation.isError
          ? threadError(
              deleteConversation.error,
              threadToDelete.mode === 'archive'
                ? 'The thread could not be archived. Please try again.'
                : 'The thread could not be deleted. Please try again.',
            )
          : undefined
      }
      onCancel={() => {
        deleteConversation.reset();
        setThreadToDelete(null);
      }}
      onConfirm={() => deleteConversation.mutate(threadToDelete)}
    />
  );
}

function NoteDeleteOverlay({ data }: { data: WorkspaceData }) {
  const { noteToDelete, deleteNote, setNoteToDelete } = data;
  if (!noteToDelete) return null;
  return (
    <DeleteThreadDialog
      title={noteToDelete.title}
      mode="delete"
      target="note"
      pending={deleteNote.isPending}
      error={
        deleteNote.isError
          ? threadError(deleteNote.error, 'The note could not be deleted. Please try again.')
          : undefined
      }
      onCancel={() => {
        deleteNote.reset();
        setNoteToDelete(null);
      }}
      onConfirm={() => deleteNote.mutate(noteToDelete)}
    />
  );
}

function SettingsOverlay({ data, config }: { data: WorkspaceData; config: AppConfig }) {
  const {
    settingsOpen,
    personaEditing,
    personas,
    setPersonaEditing,
    deletePersona,
    setSettingsOpen,
  } = data;
  if (!settingsOpen) return null;
  return (
    <SettingsPanel
      open={!personaEditing}
      config={config}
      personas={personas}
      onEditPersona={setPersonaEditing}
      onCreatePersona={() => {
        const template = DEFAULT_PERSONAS[0]!;
        setPersonaEditing({
          ...template,
          id: '',
          revision: 0,
          name: 'New persona',
          icon: 'user',
        });
      }}
      onDeletePersona={deletePersona}
      onClose={() => setSettingsOpen(false)}
    />
  );
}

function SidebarScrim({ data }: { data: WorkspaceData }) {
  const { sidebar, setSidebar } = data;
  if (!sidebar) return null;
  return (
    <button
      className="sidebar-scrim"
      aria-label="Close sidebar"
      onClick={() => setSidebar(false)}
    />
  );
}

function threadError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message.replace(/conversation/gi, 'thread') : fallback;
}
