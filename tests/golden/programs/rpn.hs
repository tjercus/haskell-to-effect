-- An interactive calculator for expressions in reverse Polish notation.
module Main where

data Token = Num Int | Op Char deriving Show

tokenize :: String -> [Token]
tokenize = map toToken . words
  where
    toToken w = case w of
      "+" -> Op '+'
      "-" -> Op '-'
      "*" -> Op '*'
      _ -> Num (readInt w)

readInt :: String -> Int
readInt ('-':ds) = negate (readInt ds)
readInt ds = foldl (\acc d -> acc * 10 + digit d) 0 ds

digit :: Char -> Int
digit c = go 0 "0123456789"
  where
    go n (d:ds) = if d == c then n else go (n + 1) ds
    go _ [] = error ("not a digit: " ++ [c])

eval :: [Token] -> Either String Int
eval = go []
  where
    go [x] [] = Right x
    go stack [] = Left ("bad stack: " ++ show stack)
    go stack (Num n : ts) = go (n : stack) ts
    go (y : x : rest) (Op o : ts) = go (apply o x y : rest) ts
    go _ (Op o : _) = Left ("not enough operands for " ++ [o])

apply :: Char -> Int -> Int -> Int
apply '+' = (+)
apply '-' = (-)
apply '*' = (*)
apply _ = \_ _ -> 0

render :: Either String Int -> String
render (Left err) = "error: " ++ err
render (Right n) = show n

loop :: IO ()
loop = do
  line <- getLine
  if line == "quit"
    then putStrLn "bye"
    else do
      putStrLn (line ++ " => " ++ render (eval (tokenize line)))
      loop

main :: IO ()
main = loop
