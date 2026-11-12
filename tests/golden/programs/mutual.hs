-- Mutually recursive tail calls are merged into one loop, so they run at any depth.
module Main where

isEven :: Int -> Bool
isEven 0 = True
isEven n = isOdd (n - 1)

isOdd :: Int -> Bool
isOdd 0 = False
isOdd n = isEven (n - 1)

-- A two-state machine that counts words, mixing self and cross calls.
inWord :: Int -> String -> Int
inWord n [] = n
inWord n (c:cs) = if c == ' ' then inSpace n cs else inWord n cs

inSpace :: Int -> String -> Int
inSpace n [] = n
inSpace n (c:cs) = if c == ' ' then inSpace n cs else inWord (n + 1) cs

-- Polymorphic, with separate signatures: their type variables are identified.
keep :: [a] -> [a] -> [a]
keep acc [] = reverse acc
keep acc (x:xs) = skip (x : acc) xs

skip :: [a] -> [a] -> [a]
skip acc [] = reverse acc
skip acc (_:xs) = keep acc xs

-- Polymorphic, without signatures: generalised together.
firstOf lefts rights [] = (lefts, rights)
firstOf lefts rights (x:xs) = secondOf (x : lefts) rights xs
secondOf lefts rights [] = (lefts, rights)
secondOf lefts rights (x:xs) = firstOf lefts (x : rights) xs

collatzMax :: Int -> Int
collatzMax n = up n n
  where
    up best 1 = best
    up best m = if m `mod` 2 == 0 then down (max best m) m else up (max best m) (3 * m + 1)
    down best m = up best (m `div` 2)

-- Not tail calls: still ordinary (stack-using) mutual recursion.
ping :: Int -> Int
ping 0 = 0
ping n = 1 + pong (n - 1)

pong :: Int -> Int
pong 0 = 0
pong n = 1 + ping (n - 1)

main :: IO ()
main = do
  print (isEven 1000000, isOdd 1000001, isEven 7)
  print (inSpace 0 (concat (replicate 50000 "ab ")), inSpace 0 "  two  words ")
  print (keep [] [1, 2, 3, 4, 5], length (keep [] (replicate 300000 'x')))
  let (ls, rs) = firstOf [] [] "abcdef"
  print (ls, rs, length (fst (firstOf [] [] (replicate 200000 True))))
  print (collatzMax 27)
  let check = isOdd
  print (map check [1, 2, 3])
  print (ping 1000)
