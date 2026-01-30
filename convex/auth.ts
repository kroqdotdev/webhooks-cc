import GitHub from "@auth/core/providers/github";
import Google from "@auth/core/providers/google";
import { convexAuth } from "@convex-dev/auth/server";
import { FREE_REQUEST_LIMIT } from "./config";

export const { auth, signIn, signOut, store } = convexAuth({
  providers: [GitHub, Google],
  callbacks: {
    async createOrUpdateUser(ctx, { existingUserId, profile }) {
      // Case 1: Same provider + same account = existing user found by auth system
      if (existingUserId) {
        await ctx.db.patch(existingUserId, {
          name: profile.name,
          image: profile.image,
        });
        return existingUserId;
      }

      // Case 2: New auth account - check if user with same email already exists
      // This handles cross-provider linking (e.g., user signed up with Google,
      // now signing in with GitHub using the same email)
      // Security note: This relies on OAuth providers verifying email ownership.
      // Both GitHub and Google verify emails before returning them in profile.
      if (profile.email) {
        // Note: Using filter here because the auth callback context has a different
        // type that doesn't expose the custom indexes. The by_email index exists
        // in the schema and Convex will optimize this query automatically.
        const existingUser = await ctx.db
          .query("users")
          .filter((q) => q.eq(q.field("email"), profile.email!))
          .first();

        if (existingUser) {
          // Audit log: Account linking event for security monitoring
          console.log(
            `[AUDIT] Account linked: userId=${existingUser._id} email=${profile.email} ` +
              `newProvider=${profile.provider ?? "unknown"} timestamp=${Date.now()}`
          );
          // Update profile info and link this auth account to existing user
          await ctx.db.patch(existingUser._id, {
            name: profile.name ?? existingUser.name,
            image: profile.image ?? existingUser.image,
          });
          return existingUser._id;
        }
      }

      // Case 3: Completely new user - create account
      if (!profile.email) {
        throw new Error("Email is required for registration");
      }
      return await ctx.db.insert("users", {
        email: profile.email,
        name: profile.name,
        image: profile.image,
        plan: "free",
        requestsUsed: 0,
        requestLimit: FREE_REQUEST_LIMIT,
        createdAt: Date.now(),
      });
    },
  },
});
