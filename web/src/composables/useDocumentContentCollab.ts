import type { Ref } from 'vue'
import {
  type DocumentContentCollabMessage,
  type DocumentContentCollabSubscribeResponse,
  DocumentContentCollabMessageKind,
} from '@/shared/proto/packets_pb'
import { useRichTextCollab, type RichTextCollabUser } from '@/composables/useRichTextCollab'

export type DocumentContentCollabUser = RichTextCollabUser

export function useDocumentContentCollab(params: {
  documentId: Ref<string | null>
  user: Ref<DocumentContentCollabUser | null>
}) {
  return useRichTextCollab<DocumentContentCollabSubscribeResponse, DocumentContentCollabMessage, DocumentContentCollabMessageKind>({
    entityId: params.documentId,
    user: params.user,
    logLabel: 'document-content-collab',
    transportFactory: (wsStore) => ({
      syncKind: DocumentContentCollabMessageKind.SYNC,
      awarenessKind: DocumentContentCollabMessageKind.AWARENESS,
      sendSubscribe: (documentId) => wsStore.sendDocumentContentCollabSubscribe(documentId),
      sendUnsubscribe: (documentId) => wsStore.sendDocumentContentCollabUnsubscribe(documentId),
      sendMessage: (documentId, kind, payload) => wsStore.sendDocumentContentCollabMessage(documentId, kind, payload),
      onSubscribeResponse: (cb) => wsStore.onDocumentContentCollabSubscribeResponse(cb),
      onMessage: (cb) => wsStore.onDocumentContentCollabMessage(cb),
      getSubscribeResponseEntityId: (resp) => resp.documentId,
      getSubscribeResponsePersistedMarkdown: (resp) => resp.persistedMarkdown,
      getSubscribeResponseSubscriberCount: (resp) => resp.subscriberCount,
      getSubscribeResponseRoomSnapshot: (resp) => resp.roomSnapshot,
      getMessageEntityId: (msg) => msg.documentId,
      getMessageKind: (msg) => msg.kind,
      getMessagePayload: (msg) => msg.payload,
    }),
  })
}
