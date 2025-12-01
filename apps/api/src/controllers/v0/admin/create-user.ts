import { logger as _logger, logger } from "../../../lib/logger";
import { Request, Response } from "express";
import { supabase_service } from "../../../services/supabase";
import crypto from "crypto";
import { z } from "zod";

function addIsoDurationToDate(date: Date, duration: string): Date {
  const regex =
    /P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/;
  const matches = duration.match(regex);

  if (!matches) {
    throw new Error("Invalid ISO 8601 duration format");
  }

  const [, years, months, days, hours, minutes, seconds] = matches.map(
    m => parseInt(m) || 0,
  );

  const result = new Date(date);
  result.setFullYear(result.getFullYear() + years);
  result.setMonth(result.getMonth() + months);
  result.setDate(result.getDate() + days);
  result.setHours(result.getHours() + hours);
  result.setMinutes(result.getMinutes() + minutes);
  result.setSeconds(result.getSeconds() + seconds);

  return result;
}

async function addCoupon(teamId: string, integration: any) {
  const { error } = await supabase_service.from("coupons").insert({
    team_id: teamId,
    credits: integration.coupon_credits,
    status: "active",
    from_auto_recharge: false,
    initial_credits: integration.coupon_credits,
    code: integration.coupon_code,
    is_extract: false,
    expires_at: integration.coupon_expiry
      ? addIsoDurationToDate(
          new Date(),
          integration.coupon_expiry,
        ).toISOString()
      : null,
    override_rate_limits: integration.coupon_rate_limits,
    override_concurrency: integration.coupon_concurrency,
  });

  if (error) {
    throw error;
  }

  return true;
}

export async function createUserController(req: Request, res: Response) {
  const logger = _logger.child({
    module: "v0/admin/create-user",
    method: "createUserController",
  });

  try {
    const auth = req.headers.authorization;
    if (!auth) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const [type, token] = auth.split(" ");
    if (type !== "Bearer") {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // sha-256 hash the token
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    // Look up integration by key
    const { data: integration, error: integrationError } =
      await supabase_service
        .from("user_referring_integration")
        .select("*")
        .eq("key", hashedToken)
        .single();

    if (integrationError || !integration) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const bodySchema = z.object({
      email: z.string().email(),
    });

    const body = bodySchema.parse(req.body);

    const { data: preexistingUser, error: preexistingUserError } =
      await supabase_service
        .from("users")
        .select("*")
        .eq("email", body.email)
        .limit(1);
    if (preexistingUserError) {
      logger.error("Failed to look up preexisting user", {
        error: preexistingUserError,
      });
      return res
        .status(500)
        .json({ error: "Failed to look up preexisting user" });
    }

    let teamId: string;
    let apiKey: string;
    let alreadyExisted = false;

    if (
      preexistingUser.length > 0 &&
      preexistingUser[0].referrer_integration !== integration.slug
    ) {
      // check if a team of the same referrer already exists
      const { data: existingTeam, error: existingTeamError } =
        await supabase_service
          .from("teams")
          .select("*")
          .eq("referrer_integration", integration.slug)
          .limit(1);
      if (existingTeamError) {
        logger.error("Failed to look up existing team", {
          error: existingTeamError,
        });
        return res
          .status(500)
          .json({ error: "Failed to look up existing team" });
      }

      if (existingTeam.length > 0) {
        teamId = existingTeam[0].id;

        const { data: existingApiKey, error: existingApiKeyError } =
          await supabase_service
            .from("api_keys")
            .select("*")
            .eq("team_id", teamId)
            .limit(1);
        if (existingApiKeyError) {
          logger.error("Failed to look up existing api key", {
            error: existingApiKeyError,
          });
          return res
            .status(500)
            .json({ error: "Failed to look up existing api key" });
        }

        if (existingApiKey.length > 0) {
          apiKey = existingApiKey[0].key;
        } else {
          return res
            .status(500)
            .json({
              error:
                "No api key found for existing team with the same referrer",
            });
        }

        alreadyExisted = true;
      } else {
        // create a new team with this referrer
        const { data: newTeam, error: newTeamError } = await supabase_service
          .from("teams")
          .insert({
            name: "Personal",
            referrer_integration: integration.slug,
          })
          .select()
          .single();
        if (newTeamError) {
          logger.error("Failed to create new team", { error: newTeamError });
          return res.status(500).json({ error: "Failed to create new team" });
        }
        teamId = newTeam.id;

        const { data: newApiKey, error: newApiKeyError } =
          await supabase_service
            .from("api_keys")
            .insert({
              name: "Default",
              team_id: teamId,
              owner_id: preexistingUser[0].id,
            })
            .select()
            .single();
        if (newApiKeyError) {
          logger.error("Failed to create new api key", {
            error: newApiKeyError,
          });
          return res
            .status(500)
            .json({ error: "Failed to create new api key" });
        }
        apiKey = newApiKey.key;

        await addCoupon(teamId, integration);
      }
    } else {
      const { data: newUser, error: newUserError } =
        await supabase_service.auth.admin.createUser({
          email: req.body.email,
          email_confirm: true,
          user_metadata: {
            referrer_integration: integration.slug,
          },
        });

      if (newUserError) {
        logger.error("Failed to create user", { error: newUserError });
        return res.status(500).json({ error: "Failed to create user" });
      }

      const { data: newUserFc, error: newUserFcError } = await supabase_service
        .from("users")
        .select("*")
        .eq("id", newUser.user.id)
        .single();
      if (newUserFcError || !newUserFc) {
        logger.error("Failed to look up new user", { error: newUserFcError });
        return res.status(500).json({ error: "Failed to look up new user" });
      }

      teamId = newUserFc.team_id;

      const { data: apiKeyFc, error: apiKeyFcError } = await supabase_service
        .from("api_keys")
        .select("*")
        .eq("team_id", teamId)
        .single();
      if (apiKeyFcError || !apiKeyFc) {
        logger.error("Failed to look up api key", { error: apiKeyFcError });
        return res.status(500).json({ error: "Failed to look up api key" });
      }

      apiKey = apiKeyFc.key;

      await addCoupon(teamId, integration);
    }

    return res.status(200).json({
      apiKey,
      alreadyExisted,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.message });
    } else {
      return res.status(500).json({ error: "Internal server error" });
    }
  }
}
