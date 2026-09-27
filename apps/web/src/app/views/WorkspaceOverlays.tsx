import { DEFAULT_PERSONAS } from '@walden/contracts';
import { DeleteThreadDialog } from '../../features/chat/DeleteThreadDialog';
import { PersonaEditor } from '../../features/personas/PersonaEditor';
import { SettingsPanel } from '../../features/settings/SettingsPanel';
import { useWorkspaceShell } from '../data/workspace-context';

export function WorkspaceOverlays() {
  return (
    <>
      <PersonaOverlay />
      <ThreadDeleteOverlay />
      <NoteDeleteOverlay />
      <SettingsOverlay />
      <SidebarScrim />
    </>
  );
}

function PersonaOverlay() {
  const { personaEditing, personas, savePersona, deleteEditingPersona, setPersonaEditing } =
    useWorkspaceShell();
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

function ThreadDeleteOverlay() {
  const {
    threadToDelete,
    setThreadToDelete,
    deletingThread,
    threadDeleteError,
    confirmThreadDeletion,
    resetThreadDeletion,
  } = useWorkspaceShell();
  if (!threadToDelete) return null;
  return (
    <DeleteThreadDialog
      title={threadToDelete.thread.title}
      mode={threadToDelete.mode}
      pending={deletingThread}
      error={
        threadDeleteError
          ? threadError(
              threadDeleteError,
              threadToDelete.mode === 'archive'
                ? 'The thread could not be archived. Please try again.'
                : 'The thread could not be deleted. Please try again.',
            )
          : undefined
      }
      onCancel={() => {
        resetThreadDeletion();
        setThreadToDelete(null);
      }}
      onConfirm={() => confirmThreadDeletion(threadToDelete)}
    />
  );
}

function NoteDeleteOverlay() {
  const {
    noteToDelete,
    setNoteToDelete,
    deletingNote,
    noteDeleteError,
    confirmNoteDeletion,
    resetNoteDeletion,
  } = useWorkspaceShell();
  if (!noteToDelete) return null;
  return (
    <DeleteThreadDialog
      title={noteToDelete.title}
      mode="delete"
      target="note"
      pending={deletingNote}
      error={
        noteDeleteError
          ? threadError(noteDeleteError, 'The note could not be deleted. Please try again.')
          : undefined
      }
      onCancel={() => {
        resetNoteDeletion();
        setNoteToDelete(null);
      }}
      onConfirm={() => confirmNoteDeletion(noteToDelete)}
    />
  );
}

function SettingsOverlay() {
  const {
    settingsOpen,
    personaEditing,
    personas,
    setPersonaEditing,
    deletePersona,
    setSettingsOpen,
  } = useWorkspaceShell();
  if (!settingsOpen) return null;
  return (
    <SettingsPanel
      open={!personaEditing}
      personas={personas}
      onEditPersona={setPersonaEditing}
      onCreatePersona={() => {
        const template = DEFAULT_PERSONAS[0]!;
        setPersonaEditing({
          ...template,
          id: '',
          name: 'New persona',
          icon: 'user',
        });
      }}
      onDeletePersona={deletePersona}
      onClose={() => setSettingsOpen(false)}
    />
  );
}

function SidebarScrim() {
  const { sidebar, setSidebar } = useWorkspaceShell();
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
