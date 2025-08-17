export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Content-Type': 'application/json'
    };

    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // 健康检查
      if (path === '/health') {
        return new Response(JSON.stringify({
          status: 'ok',
          timestamp: new Date().toISOString(),
          version: '1.0.0',
          service: 'Private Board System API'
        }), { headers: corsHeaders });
      }

      // 调试端点
      if (path === '/debug/env' && method === 'GET') {
        return new Response(JSON.stringify({
          hasClaudeKey: !!env.CLAUDE_API_KEY,
          keyLength: env.CLAUDE_API_KEY?.length || 0,
          keyPrefix: env.CLAUDE_API_KEY?.substring(0, 20) || 'none'
        }), { headers: corsHeaders });
      }

      // 董事相关API
      if (path === '/directors/active/list' && method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM directors WHERE is_active = 1 ORDER BY created_at DESC'
        ).all();

        return new Response(JSON.stringify({
          success: true,
          data: results
        }), { headers: corsHeaders });
      }

      if (path === '/directors' && method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM directors ORDER BY created_at DESC'
        ).all();

        return new Response(JSON.stringify({
          success: true,
          data: results
        }), { headers: corsHeaders });
      }

      if (path === '/directors/create-from-prompt' && method === 'POST') {
        const { system_prompt, avatar_url } = await request.json();

        if (!system_prompt) {
          return new Response(JSON.stringify({
            success: false,
            error: 'System prompt is required'
          }), {
            status: 400,
            headers: corsHeaders
          });
        }

        if (!env.CLAUDE_API_KEY) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Claude API key not configured'
          }), {
            status: 500,
            headers: corsHeaders
          });
        }

        const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.CLAUDE_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1000,
            messages: [{
              role: 'user',
              content: `Based on the following character prompt, extract and generate director information in JSON format:

Character prompt: ${system_prompt}

Please return JSON in this format:
{
  "name": "Character name",
  "title": "Title or profession",
  "era": "Time period",
  "personality_traits": ["trait1", "trait2", "trait3"],
  "core_beliefs": ["belief1", "belief2", "belief3"],
  "speaking_style": "Speaking style description",
  "expertise_areas": ["area1", "area2"]
}

Return only JSON, no other text.`
            }]
          })
        });

        if (!claudeResponse.ok) {
          const errorText = await claudeResponse.text();
          return new Response(JSON.stringify({
            success: false,
            error: `Claude API failed: ${claudeResponse.status} - ${errorText}`
          }), {
            status: 500,
            headers: corsHeaders
          });
        }

        const claudeData = await claudeResponse.json();
        let parsedDirector;

        try {
          let content = claudeData.content[0].text;
          // 如果内容被包在代码块中，提取JSON部分
          if (content.includes('```json')) {
            const match = content.match(/```json\s*([\s\S]*?)\s*```/);
            if (match) {
              content = match[1];
            }
          }
          parsedDirector = JSON.parse(content);
        } catch (parseError) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Failed to parse Claude API response'
          }), {
            status: 500,
            headers: corsHeaders
          });
        }

        const id = crypto.randomUUID();
        const director = {
          id,
          name: parsedDirector.name || 'Unknown Director',
          title: parsedDirector.title || 'Historical Figure',
          era: parsedDirector.era || 'Unknown Era',
          system_prompt,
          avatar_url: avatar_url || null,
          personality_traits: JSON.stringify(parsedDirector.personality_traits || []),
          core_beliefs: JSON.stringify(parsedDirector.core_beliefs || []),
          speaking_style: parsedDirector.speaking_style || 'Unknown Style',
          expertise_areas: JSON.stringify(parsedDirector.expertise_areas || []),
          is_active: 1,
          status: 'active',
          total_statements: 0,
          total_meetings: 0,
          created_by: 'claude_ai',
          metadata: JSON.stringify({ claude_tokens: claudeData.usage?.output_tokens || 0 }),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };

        await env.DB.prepare(`
          INSERT INTO directors (id, name, title, era, system_prompt, avatar_url, personality_traits,
                               core_beliefs, speaking_style, expertise_areas, is_active, status,
                               total_statements, total_meetings, created_by, metadata, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          director.id, director.name, director.title, director.era, director.system_prompt,
          director.avatar_url, director.personality_traits, director.core_beliefs,
          director.speaking_style, director.expertise_areas, director.is_active,
          director.status, director.total_statements, director.total_meetings,
          director.created_by, director.metadata, director.created_at, director.updated_at
        ).run();

        return new Response(JSON.stringify({
          success: true,
          data: director
        }), { headers: corsHeaders });
      }

      // 会议相关API
      if (path === '/meetings' && method === 'POST') {
        const { title, description, topic, discussion_mode, max_rounds, max_participants, director_ids } = await request.json();

        if (!title || !topic || !director_ids || director_ids.length === 0) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Title, topic and director_ids are required'
          }), {
            status: 400,
            headers: corsHeaders
          });
        }

        const meetingId = crypto.randomUUID();
        const meeting = {
          id: meetingId,
          title,
          description: description || '',
          topic,
          status: 'preparing',
          max_rounds: max_rounds || 10,
          current_round: 0,
          discussion_mode: discussion_mode || 'round_robin',
          max_participants: max_participants || 8,
          total_statements: 0,
          total_participants: director_ids.length,
          created_by: 'user',
          settings: JSON.stringify({}),
          summary: '',
          key_points: JSON.stringify([]),
          controversies: JSON.stringify([]),
          metadata: JSON.stringify({}),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };

        // 创建会议
        await env.DB.prepare(`
          INSERT INTO meetings (id, title, description, topic, status, max_rounds, current_round,
                              discussion_mode, max_participants, total_statements, total_participants,
                              created_by, settings, summary, key_points, controversies, metadata,
                              created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          meeting.id, meeting.title, meeting.description, meeting.topic, meeting.status,
          meeting.max_rounds, meeting.current_round, meeting.discussion_mode,
          meeting.max_participants, meeting.total_statements, meeting.total_participants,
          meeting.created_by, meeting.settings, meeting.summary, meeting.key_points,
          meeting.controversies, meeting.metadata, meeting.created_at, meeting.updated_at
        ).run();

        // 添加参与者
        for (let i = 0; i < director_ids.length; i++) {
          const directorId = director_ids[i];
          const participantId = crypto.randomUUID();
          
          await env.DB.prepare(`
            INSERT INTO meeting_participants (id, meeting_id, director_id, join_order, is_active,
                                           status, statements_count, total_tokens_used, joined_at,
                                           settings, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            participantId, meetingId, directorId, i + 1, 1, 'joined', 0, 0,
            new Date().toISOString(), JSON.stringify({}),
            new Date().toISOString(), new Date().toISOString()
          ).run();
        }

        return new Response(JSON.stringify({
          success: true,
          data: meeting
        }), { headers: corsHeaders });
      }

      if (path === '/meetings' && method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM meetings ORDER BY created_at DESC LIMIT 50'
        ).all();

        return new Response(JSON.stringify({
          success: true,
          data: results
        }), { headers: corsHeaders });
      }

      // 开始会议
      if (path.startsWith('/meetings/') && path.endsWith('/start') && method === 'POST') {
        const meetingId = path.split('/')[2];
        
        const meeting = await env.DB.prepare(
          'SELECT * FROM meetings WHERE id = ?'
        ).bind(meetingId).first();

        if (!meeting) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Meeting not found'
          }), {
            status: 404,
            headers: corsHeaders
          });
        }

        if (meeting.status !== 'preparing') {
          return new Response(JSON.stringify({
            success: false,
            error: 'Meeting cannot be started'
          }), {
            status: 400,
            headers: corsHeaders
          });
        }

        // 更新会议状态为讨论中
        await env.DB.prepare(`
          UPDATE meetings 
          SET status = 'discussing', started_at = ?, current_round = 1, updated_at = ?
          WHERE id = ?
        `).bind(
          new Date().toISOString(),
          new Date().toISOString(),
          meetingId
        ).run();

        return new Response(JSON.stringify({
          success: true,
          data: { message: 'Meeting started successfully' }
        }), { headers: corsHeaders });
      }

      // 生成下一个发言
      if (path.startsWith('/meetings/') && path.endsWith('/next-statement') && method === 'POST') {
        const meetingId = path.split('/')[2];
        
        const meeting = await env.DB.prepare(
          'SELECT * FROM meetings WHERE id = ?'
        ).bind(meetingId).first();

        if (!meeting) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Meeting not found'
          }), {
            status: 404,
            headers: corsHeaders
          });
        }

        if (!['discussing', 'debating'].includes(meeting.status)) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Meeting is not active'
          }), {
            status: 400,
            headers: corsHeaders
          });
        }

        // 获取会议参与者
        const { results: participants } = await env.DB.prepare(`
          SELECT mp.*, d.* 
          FROM meeting_participants mp 
          JOIN directors d ON mp.director_id = d.id 
          WHERE mp.meeting_id = ? AND mp.is_active = 1 
          ORDER BY mp.join_order
        `).bind(meetingId).all();

        if (participants.length === 0) {
          return new Response(JSON.stringify({
            success: false,
            error: 'No participants found'
          }), {
            status: 400,
            headers: corsHeaders
          });
        }

        // 获取已有发言
        const { results: statements } = await env.DB.prepare(`
          SELECT * FROM statements 
          WHERE meeting_id = ? 
          ORDER BY round_number DESC, sequence_in_round DESC
        `).bind(meetingId).all();

        // 确定下一个发言人
        let nextDirector;
        let roundNumber = meeting.current_round;
        let sequenceInRound = 1;

        if (statements.length === 0) {
          // 第一个发言，选择第一个参与者
          nextDirector = participants[0];
        } else {
          const lastStatement = statements[0];
          const currentRoundStatements = statements.filter(s => s.round_number === roundNumber);
          
          if (currentRoundStatements.length >= participants.length) {
            // 当前轮已结束，开始新轮
            roundNumber++;
            sequenceInRound = 1;
            nextDirector = participants[0];
          } else {
            // 当前轮继续
            sequenceInRound = currentRoundStatements.length + 1;
            const nextParticipantIndex = currentRoundStatements.length % participants.length;
            nextDirector = participants[nextParticipantIndex];
          }
        }

        // 构建对话上下文
        const recentStatements = statements.slice(0, 5).reverse();
        const context = recentStatements.map(s => {
          const speaker = participants.find(p => p.director_id === s.director_id);
          return `${speaker?.name || 'Unknown'}: ${s.content}`;
        }).join('\n\n');

        // 调用Claude API生成发言
        const prompt = `你是${nextDirector.name}，${nextDirector.title}。

人设背景：${nextDirector.system_prompt}

会议话题：${meeting.topic}

之前的讨论：
${context || '（这是会议的开始）'}

请根据你的人设特点，针对当前话题发表你的观点。回应应该：
1. 体现你的历史背景和专业领域
2. 与之前的讨论内容相关
3. 保持你独特的说话风格
4. 长度控制在100-300字

请直接返回发言内容，不要包含任何格式标记。`;

        const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.CLAUDE_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 500,
            messages: [{
              role: 'user',
              content: prompt
            }]
          })
        });

        if (!claudeResponse.ok) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Failed to generate statement'
          }), {
            status: 500,
            headers: corsHeaders
          });
        }

        const claudeData = await claudeResponse.json();
        const statementContent = claudeData.content[0].text;

        // 保存发言到数据库
        const statementId = crypto.randomUUID();
        await env.DB.prepare(`
          INSERT INTO statements (id, meeting_id, director_id, content, round_number, 
                                sequence_in_round, tokens_used, claude_model, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          statementId, meetingId, nextDirector.director_id, statementContent,
          roundNumber, sequenceInRound, claudeData.usage?.output_tokens || 0,
          'claude-sonnet-4-20250514', new Date().toISOString(), new Date().toISOString()
        ).run();

        // 更新会议统计
        await env.DB.prepare(`
          UPDATE meetings 
          SET total_statements = total_statements + 1, current_round = ?, updated_at = ?
          WHERE id = ?
        `).bind(roundNumber, new Date().toISOString(), meetingId).run();

        // 更新参与者统计
        await env.DB.prepare(`
          UPDATE meeting_participants 
          SET statements_count = statements_count + 1, last_statement_at = ?, updated_at = ?
          WHERE meeting_id = ? AND director_id = ?
        `).bind(
          new Date().toISOString(), new Date().toISOString(),
          meetingId, nextDirector.director_id
        ).run();

        return new Response(JSON.stringify({
          success: true,
          data: {
            id: statementId,
            content: statementContent,
            director: {
              id: nextDirector.director_id,
              name: nextDirector.name,
              title: nextDirector.title
            },
            round_number: roundNumber,
            sequence_in_round: sequenceInRound
          }
        }), { headers: corsHeaders });
      }

      // 删除董事
      if (path.startsWith('/directors/') && method === 'DELETE' && path.split('/').length === 3) {
        const directorId = path.split('/')[2];
        
        const director = await env.DB.prepare(
          'SELECT * FROM directors WHERE id = ?'
        ).bind(directorId).first();

        if (!director) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Director not found'
          }), {
            status: 404,
            headers: corsHeaders
          });
        }

        // 先删除相关的外键引用记录
        await env.DB.prepare('DELETE FROM statements WHERE director_id = ?').bind(directorId).run();
        await env.DB.prepare('DELETE FROM meeting_participants WHERE director_id = ?').bind(directorId).run();
        
        // 删除董事
        await env.DB.prepare('DELETE FROM directors WHERE id = ?').bind(directorId).run();

        return new Response(JSON.stringify({
          success: true,
          data: { message: 'Director deleted successfully' }
        }), { headers: corsHeaders });
      }

      // 批量更新董事状态
      if (path === '/directors/batch-status' && method === 'PATCH') {
        const { director_ids, status, is_active } = await request.json();

        if (!director_ids || !Array.isArray(director_ids)) {
          return new Response(JSON.stringify({
            success: false,
            error: 'director_ids array is required'
          }), {
            status: 400,
            headers: corsHeaders
          });
        }

        let updateCount = 0;
        for (const directorId of director_ids) {
          const result = await env.DB.prepare(`
            UPDATE directors 
            SET status = ?, is_active = ?, updated_at = ?
            WHERE id = ?
          `).bind(
            status || 'active',
            is_active !== undefined ? (is_active ? 1 : 0) : 1,
            new Date().toISOString(),
            directorId
          ).run();
          
          if (result.success) updateCount++;
        }

        return new Response(JSON.stringify({
          success: true,
          data: { updated_count: updateCount }
        }), { headers: corsHeaders });
      }

      // 用户提问相关API
      if (path.startsWith('/meetings/') && path.endsWith('/questions') && method === 'POST') {
        const meetingId = path.split('/')[2];
        const { question, asker_name, question_type } = await request.json();

        if (!question) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Question is required'
          }), {
            status: 400,
            headers: corsHeaders
          });
        }

        const meeting = await env.DB.prepare(
          'SELECT * FROM meetings WHERE id = ?'
        ).bind(meetingId).first();

        if (!meeting) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Meeting not found'
          }), {
            status: 404,
            headers: corsHeaders
          });
        }

        const questionId = crypto.randomUUID();
        await env.DB.prepare(`
          INSERT INTO user_questions (id, meeting_id, question, asker_name, question_type, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          questionId, meetingId, question, asker_name || '用户',
          question_type || 'general', new Date().toISOString(), new Date().toISOString()
        ).run();

        return new Response(JSON.stringify({
          success: true,
          data: { id: questionId, question, status: 'pending' }
        }), { headers: corsHeaders });
      }

      if (path.startsWith('/meetings/') && path.includes('/questions') && !path.endsWith('/questions') && method === 'GET') {
        const meetingId = path.split('/')[2];
        
        const { results: questions } = await env.DB.prepare(`
          SELECT q.*, 
                 COUNT(r.id) as response_count
          FROM user_questions q
          LEFT JOIN question_responses r ON q.id = r.question_id
          WHERE q.meeting_id = ?
          GROUP BY q.id
          ORDER BY q.created_at DESC
        `).bind(meetingId).all();

        return new Response(JSON.stringify({
          success: true,
          data: questions
        }), { headers: corsHeaders });
      }

      if (path.startsWith('/meetings/') && path.includes('/questions/') && path.endsWith('/respond') && method === 'POST') {
        const pathParts = path.split('/');
        const meetingId = pathParts[2];
        const questionId = pathParts[4];

        const question = await env.DB.prepare(
          'SELECT * FROM user_questions WHERE id = ? AND meeting_id = ?'
        ).bind(questionId, meetingId).first();

        if (!question) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Question not found'
          }), {
            status: 404,
            headers: corsHeaders
          });
        }

        // 获取会议参与的董事
        const { results: participants } = await env.DB.prepare(`
          SELECT mp.*, d.* 
          FROM meeting_participants mp 
          JOIN directors d ON mp.director_id = d.id 
          WHERE mp.meeting_id = ? AND mp.is_active = 1 
          ORDER BY mp.join_order
        `).bind(meetingId).all();

        if (participants.length === 0) {
          return new Response(JSON.stringify({
            success: false,
            error: 'No participants found'
          }), {
            status: 400,
            headers: corsHeaders
          });
        }

        // 为每个董事生成回应
        const responses = [];
        for (let i = 0; i < participants.length; i++) {
          const director = participants[i];
          
          const prompt = `你是${director.name}，${director.title}。

人设背景：${director.system_prompt}

有用户在会议中提出了问题："${question.question}"

请根据你的人设特点和专业领域，简洁地回应这个问题。回应应该：
1. 体现你的历史背景和观点立场
2. 保持你独特的说话风格
3. 长度控制在50-150字
4. 直接回答问题，不要过度解释

请直接返回回应内容，不要包含任何格式标记。`;

          const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': env.CLAUDE_API_KEY,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 300,
              messages: [{
                role: 'user',
                content: prompt
              }]
            })
          });

          if (claudeResponse.ok) {
            const claudeData = await claudeResponse.json();
            const responseContent = claudeData.content[0].text;

            const responseId = crypto.randomUUID();
            await env.DB.prepare(`
              INSERT INTO question_responses (id, question_id, director_id, content, response_order, tokens_used, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(
              responseId, questionId, director.director_id, responseContent, i + 1,
              claudeData.usage?.output_tokens || 0, new Date().toISOString(), new Date().toISOString()
            ).run();

            responses.push({
              id: responseId,
              director: {
                name: director.name,
                title: director.title,
                avatar_url: director.avatar_url
              },
              content: responseContent,
              response_order: i + 1
            });
          }
        }

        // 更新问题状态
        await env.DB.prepare(`
          UPDATE user_questions SET status = 'answered', updated_at = ? WHERE id = ?
        `).bind(new Date().toISOString(), questionId).run();

        return new Response(JSON.stringify({
          success: true,
          data: {
            question_id: questionId,
            responses: responses
          }
        }), { headers: corsHeaders });
      }

      // 收藏相关API
      if (path === '/favorites' && method === 'POST') {
        const { statement_id, response_id, favorite_type, tags, notes, user_id } = await request.json();

        if (!statement_id && !response_id) {
          return new Response(JSON.stringify({
            success: false,
            error: 'statement_id or response_id is required'
          }), {
            status: 400,
            headers: corsHeaders
          });
        }

        if (!favorite_type) {
          return new Response(JSON.stringify({
            success: false,
            error: 'favorite_type is required'
          }), {
            status: 400,
            headers: corsHeaders
          });
        }

        // 检查是否已收藏
        const existing = await env.DB.prepare(`
          SELECT id FROM user_favorites 
          WHERE user_id = ? AND 
                (statement_id = ? OR response_id = ?)
        `).bind(
          user_id || 'default_user',
          statement_id || null,
          response_id || null
        ).first();

        if (existing) {
          return new Response(JSON.stringify({
            success: false,
            error: '已经收藏过这条内容'
          }), {
            status: 400,
            headers: corsHeaders
          });
        }

        const favoriteId = crypto.randomUUID();
        await env.DB.prepare(`
          INSERT INTO user_favorites (id, user_id, statement_id, response_id, favorite_type, tags, notes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          favoriteId, user_id || 'default_user', statement_id || null, response_id || null,
          favorite_type, JSON.stringify(tags || []), notes || '', new Date().toISOString()
        ).run();

        return new Response(JSON.stringify({
          success: true,
          data: { id: favoriteId, message: '收藏成功' }
        }), { headers: corsHeaders });
      }

      if (path === '/favorites' && method === 'GET') {
        const url = new URL(request.url);
        const userId = url.searchParams.get('user_id') || 'default_user';
        const favoriteType = url.searchParams.get('type');

        let query = `
          SELECT f.*, 
                 s.content as statement_content, s.created_at as statement_created_at,
                 d.name as director_name, d.title as director_title, d.avatar_url as director_avatar,
                 m.title as meeting_title, m.topic as meeting_topic,
                 r.content as response_content, r.created_at as response_created_at
          FROM user_favorites f
          LEFT JOIN statements s ON f.statement_id = s.id
          LEFT JOIN question_responses r ON f.response_id = r.id
          LEFT JOIN directors d ON (s.director_id = d.id OR r.director_id = d.id)
          LEFT JOIN meetings m ON s.meeting_id = m.id
          WHERE f.user_id = ?
        `;
        const params = [userId];

        if (favoriteType) {
          query += ' AND f.favorite_type = ?';
          params.push(favoriteType);
        }

        query += ' ORDER BY f.created_at DESC';

        const { results } = await env.DB.prepare(query).bind(...params).all();

        return new Response(JSON.stringify({
          success: true,
          data: results.map(fav => ({
            ...fav,
            content: fav.statement_content || fav.response_content,
            content_created_at: fav.statement_created_at || fav.response_created_at,
            director: {
              name: fav.director_name,
              title: fav.director_title,
              avatar_url: fav.director_avatar
            },
            meeting: {
              title: fav.meeting_title,
              topic: fav.meeting_topic
            },
            tags: fav.tags ? JSON.parse(fav.tags) : []
          }))
        }), { headers: corsHeaders });
      }

      if (path.startsWith('/favorites/') && method === 'DELETE') {
        const favoriteId = path.split('/')[2];
        const url = new URL(request.url);
        const userId = url.searchParams.get('user_id') || 'default_user';

        const favorite = await env.DB.prepare(
          'SELECT * FROM user_favorites WHERE id = ? AND user_id = ?'
        ).bind(favoriteId, userId).first();

        if (!favorite) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Favorite not found'
          }), {
            status: 404,
            headers: corsHeaders
          });
        }

        await env.DB.prepare('DELETE FROM user_favorites WHERE id = ?').bind(favoriteId).run();

        return new Response(JSON.stringify({
          success: true,
          data: { message: '取消收藏成功' }
        }), { headers: corsHeaders });
      }

      if (path === '/favorites/tags' && method === 'GET') {
        const url = new URL(request.url);
        const userId = url.searchParams.get('user_id') || 'default_user';

        const { results } = await env.DB.prepare(`
          SELECT DISTINCT tags FROM user_favorites WHERE user_id = ? AND tags != '[]'
        `).bind(userId).all();

        const allTags = new Set();
        results.forEach(row => {
          try {
            const tags = JSON.parse(row.tags);
            tags.forEach(tag => allTags.add(tag));
          } catch (e) {}
        });

        return new Response(JSON.stringify({
          success: true,
          data: Array.from(allTags).sort()
        }), { headers: corsHeaders });
      }

      // 董事组合相关API
      if (path === '/director-groups' && method === 'POST') {
        const { name, description, director_ids, user_id } = await request.json();

        if (!name || !director_ids || director_ids.length === 0) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Name and director_ids are required'
          }), {
            status: 400,
            headers: corsHeaders
          });
        }

        const groupId = crypto.randomUUID();
        
        // 创建董事组合
        await env.DB.prepare(`
          INSERT INTO director_groups (id, name, description, user_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(
          groupId, name, description || '', user_id || 'default_user',
          new Date().toISOString(), new Date().toISOString()
        ).run();

        // 添加组合成员
        for (let i = 0; i < director_ids.length; i++) {
          const memberId = crypto.randomUUID();
          await env.DB.prepare(`
            INSERT INTO group_members (id, group_id, director_id, member_order, added_at)
            VALUES (?, ?, ?, ?, ?)
          `).bind(
            memberId, groupId, director_ids[i], i + 1, new Date().toISOString()
          ).run();
        }

        return new Response(JSON.stringify({
          success: true,
          data: { id: groupId, name, description, member_count: director_ids.length }
        }), { headers: corsHeaders });
      }

      if (path === '/director-groups' && method === 'GET') {
        const url = new URL(request.url);
        const userId = url.searchParams.get('user_id') || 'default_user';

        const { results: groups } = await env.DB.prepare(`
          SELECT dg.*, COUNT(gm.id) as member_count
          FROM director_groups dg
          LEFT JOIN group_members gm ON dg.id = gm.group_id
          WHERE dg.user_id = ?
          GROUP BY dg.id
          ORDER BY dg.created_at DESC
        `).bind(userId).all();

        return new Response(JSON.stringify({
          success: true,
          data: groups
        }), { headers: corsHeaders });
      }

      if (path.startsWith('/director-groups/') && !path.includes('/', 18) && method === 'GET') {
        const groupId = path.split('/')[2];
        
        const group = await env.DB.prepare(
          'SELECT * FROM director_groups WHERE id = ?'
        ).bind(groupId).first();

        if (!group) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Group not found'
          }), {
            status: 404,
            headers: corsHeaders
          });
        }

        // 获取组合成员
        const { results: members } = await env.DB.prepare(`
          SELECT gm.*, d.name, d.title, d.avatar_url, d.era, d.expertise_areas
          FROM group_members gm
          JOIN directors d ON gm.director_id = d.id
          WHERE gm.group_id = ?
          ORDER BY gm.member_order
        `).bind(groupId).all();

        return new Response(JSON.stringify({
          success: true,
          data: {
            ...group,
            members: members.map(m => ({
              ...m,
              director: {
                id: m.director_id,
                name: m.name,
                title: m.title,
                avatar_url: m.avatar_url,
                era: m.era,
                expertise_areas: m.expertise_areas
              }
            }))
          }
        }), { headers: corsHeaders });
      }

      if (path.startsWith('/director-groups/') && method === 'DELETE') {
        const groupId = path.split('/')[2];
        const url = new URL(request.url);
        const userId = url.searchParams.get('user_id') || 'default_user';

        const group = await env.DB.prepare(
          'SELECT * FROM director_groups WHERE id = ? AND user_id = ?'
        ).bind(groupId, userId).first();

        if (!group) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Group not found'
          }), {
            status: 404,
            headers: corsHeaders
          });
        }

        // 删除组合成员
        await env.DB.prepare('DELETE FROM group_members WHERE group_id = ?').bind(groupId).run();
        
        // 删除组合
        await env.DB.prepare('DELETE FROM director_groups WHERE id = ?').bind(groupId).run();

        return new Response(JSON.stringify({
          success: true,
          data: { message: 'Director group deleted successfully' }
        }), { headers: corsHeaders });
      }

      if (path.startsWith('/meetings/from-group/') && method === 'POST') {
        const groupId = path.split('/')[3];
        const { title, description, topic, discussion_mode, max_rounds } = await request.json();

        if (!title || !topic) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Title and topic are required'
          }), {
            status: 400,
            headers: corsHeaders
          });
        }

        // 获取组合成员
        const { results: members } = await env.DB.prepare(`
          SELECT director_id FROM group_members WHERE group_id = ? ORDER BY member_order
        `).bind(groupId).all();

        if (members.length === 0) {
          return new Response(JSON.stringify({
            success: false,
            error: 'No directors in group'
          }), {
            status: 400,
            headers: corsHeaders
          });
        }

        const director_ids = members.map(m => m.director_id);

        // 创建会议（复用现有逻辑）
        const meetingId = crypto.randomUUID();
        const meeting = {
          id: meetingId,
          title,
          description: description || '',
          topic,
          status: 'preparing',
          max_rounds: max_rounds || 10,
          current_round: 0,
          discussion_mode: discussion_mode || 'round_robin',
          max_participants: director_ids.length,
          total_statements: 0,
          total_participants: director_ids.length,
          created_by: 'user',
          settings: JSON.stringify({}),
          summary: '',
          key_points: JSON.stringify([]),
          controversies: JSON.stringify([]),
          metadata: JSON.stringify({ created_from_group: groupId }),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };

        await env.DB.prepare(`
          INSERT INTO meetings (id, title, description, topic, status, max_rounds, current_round,
                              discussion_mode, max_participants, total_statements, total_participants,
                              created_by, settings, summary, key_points, controversies, metadata,
                              created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          meeting.id, meeting.title, meeting.description, meeting.topic, meeting.status,
          meeting.max_rounds, meeting.current_round, meeting.discussion_mode,
          meeting.max_participants, meeting.total_statements, meeting.total_participants,
          meeting.created_by, meeting.settings, meeting.summary, meeting.key_points,
          meeting.controversies, meeting.metadata, meeting.created_at, meeting.updated_at
        ).run();

        // 添加参与者
        for (let i = 0; i < director_ids.length; i++) {
          const directorId = director_ids[i];
          const participantId = crypto.randomUUID();
          
          await env.DB.prepare(`
            INSERT INTO meeting_participants (id, meeting_id, director_id, join_order, is_active,
                                           status, statements_count, total_tokens_used, joined_at,
                                           settings, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            participantId, meetingId, directorId, i + 1, 1, 'joined', 0, 0,
            new Date().toISOString(), JSON.stringify({}),
            new Date().toISOString(), new Date().toISOString()
          ).run();
        }

        // 更新组合使用次数
        await env.DB.prepare(`
          UPDATE director_groups SET usage_count = usage_count + 1, updated_at = ? WHERE id = ?
        `).bind(new Date().toISOString(), groupId).run();

        return new Response(JSON.stringify({
          success: true,
          data: meeting
        }), { headers: corsHeaders });
      }

      // 金句卡片生成API
      if (path.startsWith('/statements/') && path.endsWith('/card') && method === 'GET') {
        const statementId = path.split('/')[2];
        
        const statement = await env.DB.prepare(`
          SELECT s.*, d.name as director_name, d.title as director_title, 
                 d.avatar_url as director_avatar, d.era as director_era,
                 m.title as meeting_title, m.topic as meeting_topic
          FROM statements s
          JOIN directors d ON s.director_id = d.id
          JOIN meetings m ON s.meeting_id = m.id
          WHERE s.id = ?
        `).bind(statementId).first();

        if (!statement) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Statement not found'
          }), {
            status: 404,
            headers: corsHeaders
          });
        }

        // 使用Claude API提取关键词和情感分析
        if (env.CLAUDE_API_KEY) {
          try {
            const analysisPrompt = `请分析以下发言内容，提取关键信息：

发言内容："${statement.content}"
发言人：${statement.director_name}（${statement.director_title}）

请返回JSON格式的分析结果：
{
  "keywords": ["关键词1", "关键词2", "关键词3"],
  "sentiment": "positive|neutral|negative",
  "highlight_quote": "最精彩的一句话（30字以内）",
  "theme_color": "#颜色代码（根据情感和内容推荐）",
  "category": "智慧|争议|深度|启发|经典"
}

只返回JSON，不要其他内容。`;

            const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': env.CLAUDE_API_KEY,
                'anthropic-version': '2023-06-01'
              },
              body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 300,
                messages: [{
                  role: 'user',
                  content: analysisPrompt
                }]
              })
            });

            if (claudeResponse.ok) {
              const claudeData = await claudeResponse.json();
              let analysisResult = {};
              
              try {
                let content = claudeData.content[0].text;
                if (content.includes('```json')) {
                  const match = content.match(/```json\s*([\s\S]*?)\s*```/);
                  if (match) {
                    content = match[1];
                  }
                }
                analysisResult = JSON.parse(content);
              } catch (e) {
                analysisResult = {
                  keywords: [],
                  sentiment: 'neutral',
                  highlight_quote: statement.content.substring(0, 30),
                  theme_color: '#1976d2',
                  category: '经典'
                };
              }

              return new Response(JSON.stringify({
                success: true,
                data: {
                  id: statement.id,
                  content: statement.content,
                  director: {
                    name: statement.director_name,
                    title: statement.director_title,
                    avatar_url: statement.director_avatar,
                    era: statement.director_era
                  },
                  meeting: {
                    title: statement.meeting_title,
                    topic: statement.meeting_topic
                  },
                  analysis: analysisResult,
                  created_at: statement.created_at,
                  round_number: statement.round_number
                }
              }), { headers: corsHeaders });
            }
          } catch (error) {
            console.error('Claude analysis failed:', error);
          }
        }

        // 如果Claude API不可用，返回基础数据
        return new Response(JSON.stringify({
          success: true,
          data: {
            id: statement.id,
            content: statement.content,
            director: {
              name: statement.director_name,
              title: statement.director_title,
              avatar_url: statement.director_avatar,
              era: statement.director_era
            },
            meeting: {
              title: statement.meeting_title,
              topic: statement.meeting_topic
            },
            analysis: {
              keywords: [],
              sentiment: 'neutral',
              highlight_quote: statement.content.substring(0, 30),
              theme_color: '#1976d2',
              category: '经典'
            },
            created_at: statement.created_at,
            round_number: statement.round_number
          }
        }), { headers: corsHeaders });
      }

      // 会议摘要生成API
      if (path.startsWith('/meetings/') && path.endsWith('/summary') && method === 'POST') {
        const meetingId = path.split('/')[2];
        
        const meeting = await env.DB.prepare(
          'SELECT * FROM meetings WHERE id = ?'
        ).bind(meetingId).first();

        if (!meeting) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Meeting not found'
          }), {
            status: 404,
            headers: corsHeaders
          });
        }

        // 获取所有发言和董事信息
        const { results: statements } = await env.DB.prepare(`
          SELECT s.*, d.name as director_name, d.title as director_title
          FROM statements s
          JOIN directors d ON s.director_id = d.id
          WHERE s.meeting_id = ?
          ORDER BY s.round_number, s.sequence_in_round
        `).bind(meetingId).all();

        if (statements.length === 0) {
          return new Response(JSON.stringify({
            success: false,
            error: 'No statements found in meeting'
          }), {
            status: 400,
            headers: corsHeaders
          });
        }

        // 构建发言内容
        const discussionContent = statements.map((s, index) => 
          `${index + 1}. ${s.director_name}（${s.director_title}）：\n${s.content}`
        ).join('\n\n');

        if (!env.CLAUDE_API_KEY) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Claude API key not configured'
          }), {
            status: 500,
            headers: corsHeaders
          });
        }

        // 使用Claude API生成摘要
        const summaryPrompt = `请为以下董事会会议生成专业摘要：

会议标题：${meeting.title}
讨论话题：${meeting.topic}
参与董事：${statements.map(s => s.director_name).filter((name, index, arr) => arr.indexOf(name) === index).join('、')}
总发言数：${statements.length}轮

完整讨论内容：
${discussionContent}

请生成JSON格式的会议摘要：
{
  "executive_summary": "会议核心要点总结（150字以内）",
  "key_points": ["要点1", "要点2", "要点3"],
  "agreements": ["达成的共识点"],
  "disagreements": ["争议分歧点"],
  "insights": ["深度洞察和启发"],
  "participant_highlights": [
    {
      "director": "董事姓名",
      "key_contribution": "主要贡献观点"
    }
  ],
  "next_steps": ["后续可探讨的方向"],
  "rating": {
    "depth": 8,
    "controversy": 6,
    "insight": 9
  }
}

只返回JSON，不要其他内容。`;

        try {
          const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': env.CLAUDE_API_KEY,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 1500,
              messages: [{
                role: 'user',
                content: summaryPrompt
              }]
            })
          });

          if (!claudeResponse.ok) {
            throw new Error(`Claude API failed: ${claudeResponse.status}`);
          }

          const claudeData = await claudeResponse.json();
          let summaryResult = {};
          
          try {
            let content = claudeData.content[0].text;
            if (content.includes('```json')) {
              const match = content.match(/```json\s*([\s\S]*?)\s*```/);
              if (match) {
                content = match[1];
              }
            }
            summaryResult = JSON.parse(content);
          } catch (e) {
            summaryResult = {
              executive_summary: '会议讨论了' + meeting.topic + '，各位董事发表了深度见解。',
              key_points: ['讨论话题：' + meeting.topic],
              agreements: [],
              disagreements: [],
              insights: [],
              participant_highlights: [],
              next_steps: [],
              rating: { depth: 7, controversy: 5, insight: 7 }
            };
          }

          // 更新会议摘要到数据库
          await env.DB.prepare(`
            UPDATE meetings 
            SET summary = ?, key_points = ?, controversies = ?, metadata = ?, updated_at = ?
            WHERE id = ?
          `).bind(
            summaryResult.executive_summary,
            JSON.stringify(summaryResult.key_points),
            JSON.stringify(summaryResult.disagreements),
            JSON.stringify({ 
              summary_generated: true,
              ai_analysis: summaryResult,
              tokens_used: claudeData.usage?.output_tokens || 0
            }),
            new Date().toISOString(),
            meetingId
          ).run();

          return new Response(JSON.stringify({
            success: true,
            data: {
              meeting_id: meetingId,
              summary: summaryResult,
              generated_at: new Date().toISOString()
            }
          }), { headers: corsHeaders });

        } catch (error) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Failed to generate summary: ' + error.message
          }), {
            status: 500,
            headers: corsHeaders
          });
        }
      }

      // 会议全文导出API
      if (path.startsWith('/meetings/') && path.endsWith('/export') && method === 'POST') {
        const meetingId = path.split('/')[2];
        const { export_type, include_analysis } = await request.json();

        const meeting = await env.DB.prepare(
          'SELECT * FROM meetings WHERE id = ?'
        ).bind(meetingId).first();

        if (!meeting) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Meeting not found'
          }), {
            status: 404,
            headers: corsHeaders
          });
        }

        // 获取详细的会议数据
        const { results: statements } = await env.DB.prepare(`
          SELECT s.*, d.name as director_name, d.title as director_title, d.era as director_era
          FROM statements s
          JOIN directors d ON s.director_id = d.id
          WHERE s.meeting_id = ?
          ORDER BY s.round_number, s.sequence_in_round
        `).bind(meetingId).all();

        const { results: participants } = await env.DB.prepare(`
          SELECT mp.*, d.name, d.title, d.era, d.expertise_areas
          FROM meeting_participants mp
          JOIN directors d ON mp.director_id = d.id
          WHERE mp.meeting_id = ?
          ORDER BY mp.join_order
        `).bind(meetingId).all();

        const { results: questions } = await env.DB.prepare(`
          SELECT q.*, COUNT(r.id) as response_count
          FROM user_questions q
          LEFT JOIN question_responses r ON q.id = r.question_id
          WHERE q.meeting_id = ?
          GROUP BY q.id
          ORDER BY q.created_at
        `).bind(meetingId).all();

        // 生成不同格式的导出内容
        let exportContent = '';
        let shareId = crypto.randomUUID();

        if (export_type === 'markdown') {
          exportContent = `# ${meeting.title}

**会议信息**
- 讨论话题：${meeting.topic}
- 开始时间：${meeting.started_at || '未开始'}
- 状态：${meeting.status}
- 轮数：${meeting.current_round}/${meeting.max_rounds}
- 总发言：${statements.length}条

## 参与董事

${participants.map(p => `- **${p.name}**（${p.title}，${p.era}）`).join('\n')}

## 会议讨论记录

${statements.map((s, index) => {
  const roundMark = index === 0 || s.round_number !== statements[index - 1]?.round_number 
    ? `\n### 第${s.round_number}轮\n\n` : '';
  
  return `${roundMark}**${s.director_name}**：\n\n${s.content}\n\n---\n`;
}).join('')}

${questions.length > 0 ? `## 用户提问

${questions.map((q, index) => `**问题${index + 1}**：${q.question}\n*提问者：${q.asker_name}*\n`).join('\n')}` : ''}

---
*由私人董事会系统自动生成*`;

        } else if (export_type === 'text') {
          exportContent = `${meeting.title}

会议信息：
讨论话题：${meeting.topic}
开始时间：${meeting.started_at || '未开始'}
参与董事：${participants.map(p => p.name).join('、')}
总发言数：${statements.length}条

════════════════════════════════════════

会议讨论记录：

${statements.map((s, index) => {
  const roundMark = index === 0 || s.round_number !== statements[index - 1]?.round_number 
    ? `\n【第${s.round_number}轮】\n` : '';
  
  return `${roundMark}${s.director_name}（${s.director_title}）：\n${s.content}\n`;
}).join('\n')}

${questions.length > 0 ? `\n用户提问环节：\n${questions.map((q, index) => `问题${index + 1}：${q.question}\n提问者：${q.asker_name}\n`).join('\n')}` : ''}

════════════════════════════════════════
由私人董事会系统生成`;
        }

        // 保存分享记录
        await env.DB.prepare(`
          INSERT INTO meeting_shares (id, meeting_id, share_type, title, content, summary, 
                                    highlight_statements, view_count, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          shareId, meetingId, export_type || 'text', meeting.title, exportContent,
          meeting.summary || '', JSON.stringify([]), 0,
          new Date().toISOString(), new Date().toISOString()
        ).run();

        return new Response(JSON.stringify({
          success: true,
          data: {
            share_id: shareId,
            export_type: export_type || 'text',
            content: exportContent,
            meeting_info: {
              title: meeting.title,
              topic: meeting.topic,
              statement_count: statements.length,
              participant_count: participants.length,
              question_count: questions.length
            },
            generated_at: new Date().toISOString()
          }
        }), { headers: corsHeaders });
      }

      // 获取会议详情（包含参与者和发言）
      if (path.startsWith('/meetings/') && !path.includes('/', 10) && method === 'GET') {
        const meetingId = path.split('/')[2];
        
        const meeting = await env.DB.prepare(
          'SELECT * FROM meetings WHERE id = ?'
        ).bind(meetingId).first();

        if (!meeting) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Meeting not found'
          }), {
            status: 404,
            headers: corsHeaders
          });
        }

        // 获取参与者信息
        const { results: participants } = await env.DB.prepare(`
          SELECT mp.*, d.name, d.title, d.avatar_url, d.era
          FROM meeting_participants mp
          JOIN directors d ON mp.director_id = d.id
          WHERE mp.meeting_id = ?
          ORDER BY mp.join_order
        `).bind(meetingId).all();

        // 获取发言记录
        const { results: statements } = await env.DB.prepare(`
          SELECT s.*, d.name as director_name, d.title as director_title, d.avatar_url as director_avatar
          FROM statements s
          JOIN directors d ON s.director_id = d.id
          WHERE s.meeting_id = ?
          ORDER BY s.round_number, s.sequence_in_round
        `).bind(meetingId).all();

        // 为每个发言添加Director对象
        const statementsWithDirector = statements.map(statement => ({
          ...statement,
          Director: {
            name: statement.director_name,
            title: statement.director_title,
            avatar_url: statement.director_avatar
          }
        }));

        return new Response(JSON.stringify({
          success: true,
          data: {
            ...meeting,
            participants: participants.map(p => ({
              ...p,
              director: {
                name: p.name,
                title: p.title,
                avatar_url: p.avatar_url,
                era: p.era
              },
              statement_count: p.statements_count
            })),
            statements: statementsWithDirector
          }
        }), { headers: corsHeaders });
      }

      return new Response(JSON.stringify({
        success: false,
        error: 'API endpoint not found',
        path: path,
        method: method
      }), {
        status: 404,
        headers: corsHeaders
      });

    } catch (err) {
      return new Response(JSON.stringify({
        success: false,
        error: err.message
      }), {
        status: 500,
        headers: corsHeaders
      });
    }
  }
};