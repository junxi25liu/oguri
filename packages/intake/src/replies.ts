/**
 * The reply side of a running intake: the durable outbox, its Feishu sender,
 * and the pipeline that fills and flushes it (ADR 0030 §6–§8).
 *
 * The policy is read again on every tick, as intake's own loop does, so the
 * sender resolves its credentials at send time. A login service may start
 * before `intake.feishu` exists, and a rotated secret takes effect without a
 * restart.
 */

import type { IntakePolicy } from "@oguri/core";

import { FeishuClient } from "./feishu/client.ts";
import { FeishuReplySender } from "./outbox/feishu-sender.ts";
import { FileOutbox } from "./outbox/file-outbox.ts";
import type { ReplySender, SentReply } from "./outbox/sender.ts";
import type { OutboundReply } from "./outbox/types.ts";
import { RelayPipeline, type TickReport } from "./relay-pipeline.ts";
import type { RelayBackend } from "./relay-scan.ts";
import { intakeRooms } from "./intake.ts";
import { intakeDir } from "./state.ts";

export interface IntakeRepliesOptions {
  backend: RelayBackend;
  /** The oguri home; the queue lives under its `intake/` directory. */
  home: string;
  loadPolicy: () => Promise<IntakePolicy>;
  log?: (line: string) => void;
  now?: () => number;
  since?: number;
}

/** Sends through whichever Feishu app the policy names right now. */
class PolicyFeishuSender implements ReplySender {
  private readonly current: () => IntakePolicy;
  private key = "";
  private sender: FeishuReplySender | null = null;

  constructor(current: () => IntakePolicy) {
    this.current = current;
  }

  async send(reply: OutboundReply): Promise<SentReply> {
    const feishu = this.current().feishu;
    if (feishu === undefined) throw new Error("intake.feishu is not configured");
    const key = JSON.stringify([feishu.appId, feishu.appSecret, feishu.apiUrl ?? ""]);
    if (this.sender === null || key !== this.key) {
      this.key = key;
      this.sender = new FeishuReplySender(
        new FeishuClient({
          appId: feishu.appId,
          appSecret: feishu.appSecret,
          ...(feishu.apiUrl === undefined ? {} : { apiUrl: feishu.apiUrl }),
        }),
      );
    }
    return await this.sender.send(reply);
  }
}

export class IntakeReplies {
  readonly outbox: FileOutbox;
  private readonly pipeline: RelayPipeline;
  private readonly options: IntakeRepliesOptions;
  private policy: IntakePolicy = { enabled: false, maxReplyWords: 100 };

  constructor(options: IntakeRepliesOptions) {
    this.options = options;
    const stateDir = intakeDir(options.home);
    const now = options.now === undefined ? {} : { now: options.now };
    this.outbox = new FileOutbox({
      stateDir,
      senders: { feishu: new PolicyFeishuSender(() => this.policy) },
      ...now,
    });
    this.pipeline = new RelayPipeline({
      backend: options.backend,
      rooms: () => intakeRooms(this.policy),
      outbox: this.outbox,
      policy: () => this.policy,
      stateDir,
      ...now,
      ...(options.since === undefined ? {} : { since: options.since }),
    });
  }

  /** Scan the rooms for owed replies, follow pull requests, and send what is due. */
  async tick(signal?: AbortSignal): Promise<TickReport> {
    this.policy = await this.options.loadPolicy();
    const report = await this.pipeline.tick(signal);
    for (const { step, error } of report.errors) {
      this.options.log?.(`reply ${step} failed: ${error}`);
    }
    return report;
  }
}
