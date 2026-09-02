ALTER TABLE "waxon_v2"."tags" ADD COLUMN "aliases" text[] DEFAULT '{}'::text[] NOT NULL;
--> statement-breakpoint
INSERT INTO "waxon_v2"."embedding_spaces" ("id", "key")
VALUES (2, 'openai:text-embedding-3-small:512:topic-v2')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "waxon_v2"."question_embeddings"
  ("user_id", "space_id", "question_id", "embedding")
SELECT "user_id", 2, "question_id", "embedding"
  FROM "waxon_v2"."question_embeddings"
 WHERE "space_id" = 1
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "waxon_v2"."tags" AS tag
   SET "aliases" = alias.aliases
  FROM (VALUES
    ('Actor-Critic Methods', ARRAY['Actor-Critic', 'Actor Critic']::text[]),
    ('Attention Mechanism', ARRAY['Attention']::text[]),
    ('Autoencoders', ARRAY['Autoencoder']::text[]),
    ('Backpropagation', ARRAY['Backprop']::text[]),
    ('Batch Normalization', ARRAY['BatchNorm', 'Batch Norm', 'BN']::text[]),
    ('Computer Vision', ARRAY['CV']::text[]),
    ('Deep Q-Networks', ARRAY['DQN', 'Deep Q-Network']::text[]),
    ('Direct Preference Optimization', ARRAY['DPO']::text[]),
    ('Fine-Tuning', ARRAY['Finetuning']::text[]),
    ('Generalized Advantage Estimation', ARRAY['GAE']::text[]),
    ('Information Retrieval', ARRAY['IR']::text[]),
    ('Kullback-Leibler Divergence', ARRAY['KL Divergence', 'KLD', 'Relative Entropy']::text[]),
    ('MLOps', ARRAY['ML Ops', 'Machine Learning Operations']::text[]),
    ('Model Checkpointing', ARRAY['Checkpointing', 'Model Checkpoints']::text[]),
    ('Partially Observable Markov Decision Process', ARRAY['POMDP']::text[]),
    ('Population-Based Training', ARRAY['PBT']::text[]),
    ('Proximal Policy Optimization', ARRAY['PPO']::text[]),
    ('Random Network Distillation', ARRAY['RND']::text[]),
    ('Recurrent Neural Networks', ARRAY['RNN', 'Recurrent Neural Network']::text[]),
    ('Reinforcement Learning', ARRAY['RL']::text[]),
    ('Straight-Through Estimator', ARRAY['STE', 'Straight Through Estimator']::text[]),
    ('Variational Autoencoders', ARRAY['VAE', 'Variational Autoencoder']::text[]),
    ('Vector Embeddings', ARRAY['Embeddings', 'Embedding Vectors']::text[]),
    ('Vector Quantized Variational Autoencoder', ARRAY['VQ-VAE', 'VQVAE']::text[])
  ) AS alias(label, aliases)
 WHERE tag.label = alias.label
   AND cardinality(tag.aliases) = 0;
