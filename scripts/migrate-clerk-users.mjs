import pg from "pg";

const { Client } = pg;
const clerkApiBaseUrl = "https://api.clerk.com/v1";

function requireEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function clerkRequest(secretKey, path, init = {}) {
  const response = await fetch(`${clerkApiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  if (!response.ok) {
    let code = "unknown_error";
    try {
      const body = await response.json();
      code = body.errors?.[0]?.code ?? code;
    } catch {
      // The status and Clerk error code are sufficient without logging PII.
    }
    throw new Error(`Clerk request failed (${response.status}, ${code})`);
  }

  return response.json();
}

async function listAllClerkUsers(secretKey) {
  const users = [];

  for (let offset = 0; ; offset += 100) {
    const page = await clerkRequest(
      secretKey,
      `/users?limit=100&offset=${offset}`,
    );
    users.push(...page);
    if (page.length < 100) return users;
  }
}

function splitDisplayName(displayName) {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0],
    lastName: parts.length > 1 ? parts.slice(1).join(" ") : undefined,
  };
}

function clerkProfileForDatabaseUser(databaseUser, sourceClerkUser) {
  const fallbackName = splitDisplayName(databaseUser.displayName);
  const sourceEmails = sourceClerkUser?.email_addresses?.map(
    (email) => email.email_address,
  );
  const sourcePhones = sourceClerkUser?.phone_numbers?.map(
    (phone) => phone.phone_number,
  );

  return {
    external_id: databaseUser.id,
    email_address:
      sourceEmails?.includes(databaseUser.email) && sourceEmails.length > 0
        ? sourceEmails
        : [databaseUser.email],
    ...(sourcePhones?.length ? { phone_number: sourcePhones } : {}),
    first_name: sourceClerkUser?.first_name ?? fallbackName.firstName,
    last_name: sourceClerkUser?.last_name ?? fallbackName.lastName,
    ...(sourceClerkUser?.public_metadata
      ? { public_metadata: sourceClerkUser.public_metadata }
      : {}),
    ...(sourceClerkUser?.private_metadata
      ? { private_metadata: sourceClerkUser.private_metadata }
      : {}),
    ...(sourceClerkUser?.unsafe_metadata
      ? { unsafe_metadata: sourceClerkUser.unsafe_metadata }
      : {}),
    ...(sourceClerkUser?.locale ? { locale: sourceClerkUser.locale } : {}),
    created_at: databaseUser.createdAt.toISOString(),
    skip_password_requirement: true,
    skip_legal_checks: true,
  };
}

const database = new Client({
  connectionString: requireEnvironment("SOURCE_DATABASE_URL"),
});
const destinationSecretKey = requireEnvironment(
  "DESTINATION_CLERK_SECRET_KEY",
);
const sourceSecretKey = process.env.SOURCE_CLERK_SECRET_KEY;

await database.connect();
let databaseUsers;
try {
  databaseUsers = (
    await database.query(`
      select
        id,
        display_name as "displayName",
        email,
        created_at as "createdAt"
      from waxon_v2.users
      where id like 'clerk:user\\_%' escape '\\'
      order by id
    `)
  ).rows;
} finally {
  await database.end();
}

const [destinationUsers, sourceUsers] = await Promise.all([
  listAllClerkUsers(destinationSecretKey),
  sourceSecretKey ? listAllClerkUsers(sourceSecretKey) : [],
]);
let created = 0;
let linked = 0;
let unchanged = 0;
let matchedSourceProfiles = 0;

for (const databaseUser of databaseUsers) {
  const sourceClerkUser = sourceUsers.find((candidate) =>
    candidate.email_addresses?.some(
      (email) => email.email_address === databaseUser.email,
    ),
  );
  if (sourceClerkUser) matchedSourceProfiles += 1;

  const byExternalId = destinationUsers.find(
    (candidate) => candidate.external_id === databaseUser.id,
  );
  if (byExternalId) {
    const matchingEmail = byExternalId.email_addresses?.find(
      (email) => email.email_address === databaseUser.email,
    );
    if (!matchingEmail || matchingEmail.verification?.status !== "verified") {
      throw new Error(
        "A destination Clerk identity has the expected external ID but not the verified database email",
      );
    }
    unchanged += 1;
    continue;
  }

  const byEmail = destinationUsers.find((candidate) =>
    candidate.email_addresses?.some(
      (email) => email.email_address === databaseUser.email,
    ),
  );
  const profile = clerkProfileForDatabaseUser(databaseUser, sourceClerkUser);

  if (byEmail) {
    await clerkRequest(destinationSecretKey, `/users/${byEmail.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        external_id: profile.external_id,
        first_name: profile.first_name,
        last_name: profile.last_name,
        public_metadata: profile.public_metadata,
        private_metadata: profile.private_metadata,
        unsafe_metadata: profile.unsafe_metadata,
        locale: profile.locale,
        skip_legal_checks: true,
      }),
    });
    linked += 1;
    continue;
  }

  await clerkRequest(destinationSecretKey, "/users", {
    method: "POST",
    body: JSON.stringify(profile),
  });
  created += 1;
}

console.log(
  `databaseUsers=${databaseUsers.length} created=${created} linked=${linked} unchanged=${unchanged} matchedSourceProfiles=${matchedSourceProfiles}`,
);
