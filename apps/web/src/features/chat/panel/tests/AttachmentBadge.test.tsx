// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fetchAttachment = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/api', () => ({ fetchAttachment }));

const { AttachmentBadge } = await import('../ui/AttachmentBadge');

afterEach(cleanup);

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
  HTMLAnchorElement.prototype.click = vi.fn();
});

it('opens a PDF with the browser PDF viewer', async () => {
  render(
    <AttachmentBadge file={new File(['%PDF-1.4'], 'paper.pdf', { type: 'application/pdf' })} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open paper.pdf' }));
  expect((await screen.findByTitle('paper.pdf')).getAttribute('src')).toBe('blob:preview');
});

it('downloads a Word document directly without opening a preview', async () => {
  render(
    <AttachmentBadge
      file={
        new File(['docx'], 'paper.docx', {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        })
      }
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Download paper.docx' }));
  await waitFor(() => expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce());
  expect(HTMLDialogElement.prototype.showModal).not.toHaveBeenCalled();
});

it('does not display spreadsheet bytes as text', async () => {
  render(
    <AttachmentBadge
      file={
        new File(['binary'], 'table.xlsx', {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        })
      }
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open table.xlsx' }));
  expect(await screen.findByText(/Preview is not available/)).toBeTruthy();
  expect(screen.queryByText('binary')).toBeNull();
});

it('fetches a sent attachment from its file part URL with authentication', async () => {
  fetchAttachment.mockResolvedValue(new Blob(['%PDF-1.4'], { type: 'application/pdf' }));
  render(
    <AttachmentBadge
      file={{
        type: 'file',
        mediaType: 'application/pdf',
        filename: 'paper.pdf',
        url: '/api/chat/attachments/conversation-1/file-1',
      }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open paper.pdf' }));
  expect((await screen.findByTitle('paper.pdf')).getAttribute('src')).toBe('blob:preview');
  expect(fetchAttachment).toHaveBeenCalledWith(
    '/api/chat/attachments/conversation-1/file-1',
    expect.any(AbortSignal),
  );
});
