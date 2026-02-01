import passport from "passport";
import { Strategy as  GoogleStrategy } from 'passport-google-oauth20';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL
}, async (accessToken, refreshToken, profile, done) => {
    const existingUsers =  await db.select()
        .from(users)
        .where(eq(users.googleId, profile.id))
        .limit(1)

    const existingUser = existingUsers[0];
    if (existingUser){
        return done(null, existingUser);
    }
    const newUser = await db.insert(users)
        .values({
            googleId: profile.id,
            email: profile.emails[0].value,
            name: profile.displayName,
            profilePicture: profile.photos[0].value
        })
        .returning();
    
    return done(null, newUser[0]);
}))

// serialize
passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    try{
        const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
        done(null, result[0]);
    } catch (error) {
        done(error, null)
    }
});