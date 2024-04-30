import {BskyAgent, TempDmDefs, TempDmSendMessage} from '@atproto/api'
import {EventEmitter} from 'eventemitter3'
import {nanoid} from 'nanoid/non-secure'

export type ChatParams = {
  chatId: string
  agent: BskyAgent
  __tempFromUserDid: string
}

export enum ChatStatus {
  Uninitialized = 'uninitialized',
  Initializing = 'initializing',
  Ready = 'ready',
  Error = 'error',
  Destroyed = 'destroyed',
}

export type ChatItem =
  | {
      type: 'message'
      key: string
      message: TempDmDefs.MessageView
      nextMessage: TempDmDefs.MessageView | TempDmDefs.DeletedMessage | null
    }
  | {
      type: 'deleted-message'
      key: string
      message: TempDmDefs.DeletedMessage
      nextMessage: TempDmDefs.MessageView | TempDmDefs.DeletedMessage | null
    }
  | {
      type: 'pending-message'
      key: string
      message: TempDmSendMessage.InputSchema['message']
    }

export type ChatState =
  | {
      status: ChatStatus.Uninitialized
    }
  | {
      status: ChatStatus.Initializing
    }
  | {
      status: ChatStatus.Ready
      items: ChatItem[]
      chat: TempDmDefs.ChatView
      isFetchingHistory: boolean
    }
  | {
      status: ChatStatus.Error
      error: any
    }
  | {
      status: ChatStatus.Destroyed
    }

export class Chat {
  private chatId: string
  private agent: BskyAgent
  private __tempFromUserDid: string

  private status: ChatStatus = ChatStatus.Uninitialized
  private error: any
  private chat: TempDmDefs.ChatView | undefined
  private historyCursor: string | undefined | null = undefined
  private isFetchingHistory = false
  private eventsCursor: string | undefined = undefined

  private pastMessages: Map<
    string,
    TempDmDefs.MessageView | TempDmDefs.DeletedMessage
  > = new Map()
  private newMessages: Map<
    string,
    TempDmDefs.MessageView | TempDmDefs.DeletedMessage
  > = new Map()
  private deletedMessages: TempDmDefs.DeletedMessage[] = []
  private pendingMessages: Map<
    string,
    {id: string; message: TempDmSendMessage.InputSchema['message']}
  > = new Map()

  private pendingEventIngestion: Promise<void> | undefined

  constructor(params: ChatParams) {
    this.chatId = params.chatId
    this.agent = params.agent
    this.__tempFromUserDid = params.__tempFromUserDid
  }

  async initialize() {
    if (this.status !== 'uninitialized') return
    this.status = ChatStatus.Initializing

    try {
      const response = await this.agent.api.temp.dm.getChat(
        {
          chatId: this.chatId,
        },
        {
          headers: {
            Authorization: this.__tempFromUserDid,
          },
        },
      )
      const {chat} = response.data

      this.chat = chat
      this.status = ChatStatus.Ready

      this.commit()

      await this.fetchMessageHistory()

      this.pollEvents()
    } catch (e) {
      this.status = ChatStatus.Error
      this.error = e
    }
  }

  private async pollEvents() {
    if (this.status === ChatStatus.Destroyed) return
    if (this.pendingEventIngestion) return
    setTimeout(async () => {
      this.pendingEventIngestion = this.ingestLatestEvents()
      await this.pendingEventIngestion
      this.pendingEventIngestion = undefined
      this.pollEvents()
    }, 5e3)
  }

  async fetchMessageHistory() {
    if (this.status === ChatStatus.Destroyed) return
    // reached end
    if (this.historyCursor === null) return
    if (this.isFetchingHistory) return

    this.isFetchingHistory = true
    this.commit()

    /*
     * Delay if paginating while scrolled.
     *
     * TODO why does the FlatList jump without this delay?
     *
     * Tbh it feels a little more natural with a slight delay.
     */
    if (this.pastMessages.size > 0) {
      await new Promise(y => setTimeout(y, 500))
    }

    const response = await this.agent.api.temp.dm.getChatMessages(
      {
        cursor: this.historyCursor,
        chatId: this.chatId,
        limit: 20,
      },
      {
        headers: {
          Authorization: this.__tempFromUserDid,
        },
      },
    )
    const {cursor, messages} = response.data

    this.historyCursor = cursor || null

    for (const message of messages) {
      if (
        TempDmDefs.isMessageView(message) ||
        TempDmDefs.isDeletedMessage(message)
      ) {
        this.pastMessages.set(message.id, message)

        // set to latest rev
        if (
          // @ts-ignore TODO divy said so
          message.rev > (this.eventsCursor = this.eventsCursor || message.rev)
        ) {
          this.eventsCursor = message.rev
        }
      }
    }

    this.isFetchingHistory = false
    this.commit()
  }

  async ingestLatestEvents() {
    if (this.status === ChatStatus.Destroyed) return

    const response = await this.agent.api.temp.dm.getChatLog(
      {
        cursor: this.eventsCursor,
      },
      {
        headers: {
          Authorization: this.__tempFromUserDid,
        },
      },
    )
    const {logs} = response.data

    for (const log of logs) {
      /*
       * If there's a rev, we should handle it. If there's not a rev, we don't
       * know what it is.
       */
      if (typeof log.rev === 'string') {
        /*
         * We only care about new events
         */
        if (log.rev > (this.eventsCursor = this.eventsCursor || log.rev)) {
          /*
           * Update rev regardless of if it's a log type we care about or not
           */
          this.eventsCursor = log.rev

          /*
           * This is VERY important. We don't want to insert any messages from
           * your other chats.
           *
           * TODO there may be a better way to handle this
           */
          if (log.chatId !== this.chatId) continue

          if (
            TempDmDefs.isLogCreateMessage(log) &&
            TempDmDefs.isMessageView(log.message)
          ) {
            this.newMessages.set(log.message.id, log.message)
          } else if (
            TempDmDefs.isLogDeleteMessage(log) &&
            TempDmDefs.isDeletedMessage(log.message)
          ) {
            /*
             * Update if we have this in state. If we don't, don't worry about it.
             */
            if (this.pastMessages.has(log.message.id)) {
              this.pastMessages.set(log.message.id, log.message)
            }
          }
        }
      }
    }

    this.commit()
  }

  async sendMessage(message: TempDmSendMessage.InputSchema['message']) {
    if (this.status === ChatStatus.Destroyed) return
    // Ignore empty messages for now since they have no other purpose atm
    if (!message.text) return

    const tempId = nanoid()

    this.pendingMessages.set(tempId, {
      id: tempId,
      message,
    })
    this.commit()

    await new Promise(y => setTimeout(y, 500))
    const response = await this.agent.api.temp.dm.sendMessage(
      {
        chatId: this.chatId,
        message,
      },
      {
        encoding: 'application/json',
        headers: {
          Authorization: this.__tempFromUserDid,
        },
      },
    )
    const res = response.data

    /*
     * Insert into `newMessages` as soon as we have a real ID. That way, when
     * we get an event log back, we can replace in situ.
     */
    this.newMessages.set(res.id, {
      ...res,
      $type: 'temp.dm.defs#messageView',
      sender: this.chat?.members.find(m => m.did === this.__tempFromUserDid),
    })
    this.pendingMessages.delete(tempId)

    this.commit()
  }

  /*
   * Items in reverse order, since FlatList inverts
   *
   * TODO remove `deletedMessages` from these lists
   */
  get items(): ChatItem[] {
    const items: ChatItem[] = []

    // `newMessages` is in insertion order, unshift to reverse
    this.newMessages.forEach(m => {
      if (TempDmDefs.isMessageView(m)) {
        items.unshift({
          type: 'message',
          key: m.id,
          message: m,
          nextMessage: null,
        })
      } else if (TempDmDefs.isDeletedMessage(m)) {
        items.unshift({
          type: 'deleted-message',
          key: m.id,
          message: m,
          nextMessage: null,
        })
      }
    })

    // `newMessages` is in insertion order, unshift to reverse
    this.pendingMessages.forEach(m => {
      items.unshift({
        type: 'pending-message',
        key: m.id,
        message: m.message,
      })
    })

    this.pastMessages.forEach(m => {
      if (TempDmDefs.isMessageView(m)) {
        items.push({
          type: 'message',
          key: m.id,
          message: m,
          nextMessage: null,
        })
      } else if (TempDmDefs.isDeletedMessage(m)) {
        items.push({
          type: 'deleted-message',
          key: m.id,
          message: m,
          nextMessage: null,
        })
      }
    })

    return items.map((item, i) => {
      let nextMessage = null

      if (
        TempDmDefs.isMessageView(item.message) ||
        TempDmDefs.isDeletedMessage(item.message)
      ) {
        const next = items[i - 1]
        if (
          next &&
          (TempDmDefs.isMessageView(next.message) ||
            TempDmDefs.isDeletedMessage(next.message))
        ) {
          nextMessage = next.message
        }
      }

      return {
        ...item,
        nextMessage,
      }
    })
  }

  destroy() {
    this.status = ChatStatus.Destroyed
    this.commit()
  }

  get state(): ChatState {
    switch (this.status) {
      case ChatStatus.Initializing: {
        return {
          status: ChatStatus.Initializing,
        }
      }
      case ChatStatus.Ready: {
        return {
          status: ChatStatus.Ready,
          items: this.items,
          chat: this.chat!,
          isFetchingHistory: this.isFetchingHistory,
        }
      }
      case ChatStatus.Error: {
        return {
          status: ChatStatus.Error,
          error: this.error,
        }
      }
      case ChatStatus.Destroyed: {
        return {
          status: ChatStatus.Destroyed,
        }
      }
      default: {
        return {
          status: ChatStatus.Uninitialized,
        }
      }
    }
  }

  private _emitter = new EventEmitter()

  private commit() {
    this._emitter.emit('update')
  }

  on(event: 'update', cb: () => void) {
    this._emitter.on(event, cb)
  }

  off(event: 'update', cb: () => void) {
    this._emitter.off(event, cb)
  }
}