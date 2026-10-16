import { INestApplication } from "@nestjs/common";
import {
  http,
  registerAndVerify,
  startAuthApp,
  TEST_PASSWORD,
  TestApp,
} from "../../auth/tests/test-app";
import { CaptureMailer } from "../../auth/domain/mailer";
import { AUDIT_EVENTS_COLLECTION } from "../schemas/audit-event";

jest.setTimeout(120_000);

describe("workspace protection", () => {
  let harness: TestApp;
  let app: INestApplication;
  let mailer: CaptureMailer;

  beforeAll(async () => {
    harness = await startAuthApp();
    app = harness.app;
    mailer = harness.mailer;
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("denies guessed ids, blocks viewers from writes, and audits role changes", async () => {
    const owner = await registerAndVerify(app, mailer, "owner@example.com");
    const guest = await registerAndVerify(app, mailer, "guest@example.com");
    const ownerLogin = await http(app, "POST", "/v1/auth/login", {
      email: "owner@example.com",
      password: TEST_PASSWORD,
    });
    const guestLogin = await http(app, "POST", "/v1/auth/login", {
      email: "guest@example.com",
      password: TEST_PASSWORD,
    });
    const ownerToken = (ownerLogin.json as { accessToken: string }).accessToken;
    const guestToken = (guestLogin.json as { accessToken: string }).accessToken;

    const guessed = await http(app, "GET", `/v1/workspaces/${owner.workspaceId}`, undefined, guestToken);
    expect(guessed.code).toBe(404);

    const added = await http(
      app,
      "POST",
      `/v1/workspaces/${owner.workspaceId}/members`,
      { userId: guest.userId, role: "viewer" },
      ownerToken,
    );
    expect(added.code).toBe(201);

    const view = await http(app, "GET", `/v1/workspaces/${owner.workspaceId}`, undefined, guestToken);
    expect(view.code).toBe(200);
    expect(view.json).toEqual(
      expect.objectContaining({ id: owner.workspaceId, role: "viewer" }),
    );

    const mutate = await http(
      app,
      "PATCH",
      `/v1/workspaces/${owner.workspaceId}`,
      { name: "Hijacked" },
      guestToken,
    );
    expect(mutate.code).toBe(403);

    const role = await http(
      app,
      "PATCH",
      `/v1/workspaces/${owner.workspaceId}/members/${guest.userId}`,
      { role: "editor" },
      ownerToken,
    );
    expect(role.code).toBe(200);
    expect(role.json).toEqual({
      userId: guest.userId,
      fromRole: "viewer",
      toRole: "editor",
    });

    const events = await harness.db.collection(AUDIT_EVENTS_COLLECTION).find({}).toArray();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: owner.workspaceId,
          actorId: owner.userId,
          action: "role_change",
          targetUserId: guest.userId,
          fromRole: "viewer",
          toRole: "editor",
        }),
      ]),
    );
  });

  it("lists only the caller's workspaces, audits added members, and blocks non-owners from managing", async () => {
    const owner = await registerAndVerify(app, mailer, "lead@example.com");
    const editor = await registerAndVerify(app, mailer, "helper@example.com");
    const loginAs = async (email: string) =>
      ((await http(app, "POST", "/v1/auth/login", { email, password: TEST_PASSWORD })).json as {
        accessToken: string;
      }).accessToken;
    const ownerToken = await loginAs("lead@example.com");
    const editorToken = await loginAs("helper@example.com");

    const mine = await http(app, "GET", "/v1/workspaces", undefined, ownerToken);
    expect(mine.code).toBe(200);
    expect(mine.json).toEqual([
      { id: owner.workspaceId, name: "Personal", kind: "personal", role: "owner" },
    ]);

    const randomId = "01960000-0000-7000-8000-000000000000";
    expect((await http(app, "GET", `/v1/workspaces/${randomId}`, undefined, ownerToken)).code).toBe(404);
    expect((await http(app, "GET", "/v1/workspaces/not-an-id", undefined, ownerToken)).code).toBe(404);

    const added = await http(
      app,
      "POST",
      `/v1/workspaces/${owner.workspaceId}/members`,
      { userId: editor.userId, role: "editor" },
      ownerToken,
    );
    expect(added.code).toBe(201);

    const promote = await http(
      app,
      "PATCH",
      `/v1/workspaces/${owner.workspaceId}/members/${editor.userId}`,
      { role: "viewer" },
      editorToken,
    );
    expect(promote.code).toBe(403);

    const invite = await http(
      app,
      "POST",
      `/v1/workspaces/${owner.workspaceId}/members`,
      { userId: owner.userId, role: "viewer" },
      editorToken,
    );
    expect(invite.code).toBe(403);

    const editorList = await http(app, "GET", "/v1/workspaces", undefined, editorToken);
    expect(editorList.json).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: owner.workspaceId, role: "editor" })]),
    );

    const events = await harness.db
      .collection(AUDIT_EVENTS_COLLECTION)
      .find({ workspaceId: owner.workspaceId })
      .toArray();
    expect(events).toEqual([
      expect.objectContaining({
        action: "member_added",
        actorId: owner.userId,
        targetUserId: editor.userId,
        fromRole: null,
        toRole: "editor",
      }),
    ]);
  });
});
